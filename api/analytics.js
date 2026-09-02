'use strict';
// The Glue + Athena half of the system.
//   1. EventBridge fires exportHandler nightly.
//   2. exportHandler flattens the DynamoDB ledger to partitioned NDJSON in S3.
//   3. It then kicks the Glue crawler, which refreshes the table schema.
//   4. The web app's Reports page calls runReport, which queries that table
//      through Athena and returns rows for charting.
const { StartCrawlerCommand, GlueClient } = require('@aws-sdk/client-glue');
const { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand } = require('@aws-sdk/client-athena');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const db = require('./db');
const { reliability, isoDay } = require('./core');

const region = process.env.AWS_REGION || 'us-east-1';
const s3 = new S3Client({ region });
const glue = new GlueClient({ region });
const athena = new AthenaClient({ region });

const ANALYTICS_BUCKET = process.env.ANALYTICS_BUCKET;
const GLUE_DATABASE = process.env.GLUE_DATABASE || 'rosca_analytics';
const GLUE_CRAWLER = process.env.GLUE_CRAWLER || 'rosca-ledger-crawler';
const WORKGROUP = process.env.ATHENA_WORKGROUP || 'primary';

// Nightly: dump every contribution as one JSON object per line. Athena reads
// NDJSON natively, so no Parquet conversion step to build or debug.
// ponytail: full table scan each night. Fine to five figures of rows; switch to
// a DynamoDB Stream -> Firehose feed if the export ever runs long.
async function exportHandler() {
  const contributions = await db.scanAll('CONTRIB#');
  const dt = isoDay(new Date());
  const lines = contributions.map((c) => JSON.stringify({
    group_id: c.groupId,
    user_id: c.userId,
    user_name: c.userName,
    cycle: c.cycle,
    amount: c.amount,
    currency: c.currency,
    due_date: c.dueDate,
    paid_at: c.paidAt,
    on_time: c.onTime ? 1 : 0,
    has_evidence: c.evidenceKey ? 1 : 0,
  })).join('\n');

  await s3.send(new PutObjectCommand({
    Bucket: ANALYTICS_BUCKET,
    Key: `ledger/dt=${dt}/ledger.json`,
    Body: lines,
    ContentType: 'application/x-ndjson',
  }));

  await glue.send(new StartCrawlerCommand({ Name: GLUE_CRAWLER })).catch((e) => {
    // CrawlerRunningException just means last night's run is still going.
    if (e.name !== 'CrawlerRunningException') throw e;
  });

  return { exported: contributions.length, partition: dt };
}

async function athenaQuery(sql) {
  const start = await athena.send(new StartQueryExecutionCommand({
    QueryString: sql,
    WorkGroup: WORKGROUP,
    QueryExecutionContext: { Database: GLUE_DATABASE },
    ResultConfiguration: { OutputLocation: `s3://${ANALYTICS_BUCKET}/athena-results/` },
  }));
  const id = start.QueryExecutionId;

  for (let i = 0; i < 30; i++) {
    const { QueryExecution } = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = QueryExecution.Status.State;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(`Athena: ${QueryExecution.Status.StateChangeReason || state}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const results = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id }));
  const rows = results.ResultSet.Rows || [];
  const header = (rows[0]?.Data || []).map((d) => d.VarCharValue);
  return rows.slice(1).map((r) => Object.fromEntries(r.Data.map((d, i) => [header[i], d.VarCharValue])));
}

// Per-group reliability report shown on the Reports page.
async function runReport(groupId) {
  const safeId = String(groupId).replace(/[^A-Za-z0-9_-]/g, ''); // Athena has no bind parameters here
  const byMember = await athenaQuery(`
    SELECT user_name,
           COUNT(*) AS payments,
           SUM(on_time) AS on_time,
           ROUND(100.0 * SUM(on_time) / COUNT(*), 1) AS on_time_pct
    FROM ledger
    WHERE group_id = '${safeId}'
    GROUP BY user_name
    ORDER BY on_time_pct DESC`);

  const byCycle = await athenaQuery(`
    SELECT cycle,
           COUNT(*) AS paid,
           SUM(on_time) AS on_time,
           SUM(amount) AS pot
    FROM ledger
    WHERE group_id = '${safeId}'
    GROUP BY cycle
    ORDER BY cycle`);

  return { byMember, byCycle };
}

// Same numbers straight from DynamoDB, for the demo before the first nightly
// export has run (and if Athena is unavailable in the lab session).
async function liveReport(groupId) {
  const contributions = await db.query(`GROUP#${groupId}`, 'CONTRIB#');
  const perMember = new Map();
  const perCycle = new Map();
  for (const c of contributions) {
    const m = perMember.get(c.userId) || { user_name: c.userName, payments: 0, on_time: 0 };
    m.payments++; m.on_time += c.onTime ? 1 : 0;
    perMember.set(c.userId, m);

    const k = perCycle.get(c.cycle) || { cycle: c.cycle, paid: 0, on_time: 0, pot: 0 };
    k.paid++; k.on_time += c.onTime ? 1 : 0; k.pot += c.amount;
    perCycle.set(c.cycle, k);
  }
  return {
    byMember: [...perMember.values()]
      .map((m) => ({ ...m, on_time_pct: Math.round((1000 * m.on_time) / m.payments) / 10, score: reliability(m.on_time, m.payments) }))
      .sort((a, b) => b.on_time_pct - a.on_time_pct),
    byCycle: [...perCycle.values()].sort((a, b) => a.cycle - b.cycle),
  };
}

module.exports = { exportHandler, runReport, liveReport, athenaQuery };
