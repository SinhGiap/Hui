'use strict';
// Signs rows that carry no signature yet - rows written before tamper-evidence
// existed, or restored from a backup taken before it.
//
// It will NOT re-sign a row that already has a signature. That matters: a forged
// row and a stale-format row both fail verification, and a tool that "repairs"
// everything that fails would sign the forgery with the live key and destroy the
// only evidence that it was ever forged.
//
// Changing the field lists in api/auth.js is the one case where existing
// signatures must be recomputed. That is --rescheme, and it is deliberately a
// separate flag with its own warning, because it cannot tell a forgery from a
// row signed under the old scheme.
//
// Run: npm run resign                 report only
//      npm run resign -- --write      sign unsigned rows
//      npm run resign -- --rescheme --write   recompute every signature
const db = require('../api/db');
const { signRecord, recordIntact } = require('../api/auth');

const WRITE = process.argv.includes('--write');
const RESCHEME = process.argv.includes('--rescheme');

// One scan, routed by key shape, rather than one scan per record kind.
function classify(row) {
  const pk = String(row.PK || '');
  if (pk.startsWith('EMAIL#') && row.SK === 'USER') return 'email';
  if (pk.startsWith('USER#') && row.SK === 'PROFILE') return 'profile';
  if (pk.startsWith('GROUP#') && String(row.SK || '').startsWith('CONTRIB#')) return 'contrib';
  return null; // membership rows, mirror rows and group META are not signed
}

async function main() {
  const rows = (await db.scanAll('')).map((r) => [classify(r), r]).filter(([k]) => k);

  const unsigned = rows.filter(([, r]) => typeof r.sig !== 'string');
  const failing = rows.filter(([k, r]) => typeof r.sig === 'string' && !recordIntact(r, k));

  const counts = {};
  for (const [k] of rows) counts[k] = (counts[k] || 0) + 1;
  for (const [k, n] of Object.entries(counts)) console.log(`${k.padEnd(8)} ${n} rows`);
  console.log(`\n${unsigned.length} unsigned, ${failing.length} signed-but-not-verifying`);

  if (failing.length && !RESCHEME) {
    console.log('\nA signed row that does not verify is either a forgery or a scheme change.');
    console.log('This tool will not guess. Investigate, then use --rescheme if you changed');
    console.log('the field lists in api/auth.js.');
  }

  const todo = RESCHEME ? [...unsigned, ...failing] : unsigned;
  if (!WRITE) return console.log(`\n${todo.length} rows would be signed. Re-run with --write to apply.`);
  if (RESCHEME && failing.length) console.log('\n--rescheme: recomputing signatures over values as they currently stand.');

  for (const [kind, r] of todo) {
    await db.update({
      Key: { PK: r.PK, SK: r.SK },
      UpdateExpression: 'SET sig = :s',
      ExpressionAttributeValues: { ':s': signRecord(r, kind) },
    });
  }

  // Re-read only what was touched, serially, rather than fanning out one
  // GetItem per row in the table.
  let left = 0;
  for (const [kind, r] of todo) {
    const fresh = await db.get(r.PK, r.SK);
    if (fresh && !recordIntact(fresh, kind)) left++;
  }
  console.log(`\nsigned ${todo.length} rows; ${left} still failing verification.`);
  process.exit(left ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
