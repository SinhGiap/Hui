'use strict';
// Creates every piece of AWS infrastructure the app needs, idempotently.
// Learner Lab sessions expire and accounts get reset, so this has to be a
// one-command redo rather than a click-path in the console.
//
// Run: npm run bootstrap
const { DynamoDBClient, CreateTableCommand, waitUntilTableExists } = require('@aws-sdk/client-dynamodb');
const { S3Client, CreateBucketCommand, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
const { GlueClient, CreateDatabaseCommand, CreateCrawlerCommand } = require('@aws-sdk/client-glue');

const region = process.env.AWS_REGION || 'us-east-1';
const TABLE = process.env.TABLE_NAME || 'rosca';
const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET;
const ANALYTICS_BUCKET = process.env.ANALYTICS_BUCKET;
const GLUE_DATABASE = process.env.GLUE_DATABASE || 'rosca_analytics';
const GLUE_CRAWLER = process.env.GLUE_CRAWLER || 'rosca-ledger-crawler';
const LAB_ROLE = process.env.LAB_ROLE_ARN; // Learner Lab forbids creating roles; reuse LabRole.

const local = process.env.DYNAMO_ENDPOINT; // set = running against DynamoDB Local
const ddb = new DynamoDBClient({
  region,
  ...(local ? { endpoint: local, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
});
const s3 = new S3Client({ region });
const glue = new GlueClient({ region });

const EXISTS = ['ResourceInUseException', 'BucketAlreadyOwnedByYou', 'BucketAlreadyExists', 'AlreadyExistsException'];

async function step(label, fn) {
  try {
    await fn();
    console.log(`  created  ${label}`);
  } catch (e) {
    if (EXISTS.includes(e.name)) return console.log(`  exists   ${label}`);
    console.log(`  FAILED   ${label}: ${e.name} - ${e.message}`);
  }
}

async function main() {
  if (!local && (!EVIDENCE_BUCKET || !ANALYTICS_BUCKET)) {
    console.error('Set EVIDENCE_BUCKET and ANALYTICS_BUCKET in .env first (bucket names are globally unique).');
    process.exit(1);
  }
  console.log(`region ${region}\n`);

  console.log('DynamoDB');
  await step(`table ${TABLE}`, () => ddb.send(new CreateTableCommand({
    TableName: TABLE,
    // Single table, no secondary indexes: every access pattern is served by the
    // PK/SK shapes documented in api/db.js.
    AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    BillingMode: 'PAY_PER_REQUEST',
  })));
  await waitUntilTableExists({ client: ddb, maxWaitTime: 120 }, { TableName: TABLE }).catch(() => {});

  if (local) {
    console.log('\nDYNAMO_ENDPOINT is set, so this is local mode: skipping S3 and Glue.');
    console.log('Run without DYNAMO_ENDPOINT against the Learner Lab to create those.');
    return;
  }

  console.log('\nS3');
  for (const Bucket of [EVIDENCE_BUCKET, ANALYTICS_BUCKET]) {
    await step(`bucket ${Bucket}`, () => s3.send(new CreateBucketCommand({ Bucket })));
  }
  // The browser PUTs evidence images straight to S3 with a presigned URL, which
  // is a cross-origin request, so the bucket needs its own CORS rule.
  await step(`CORS on ${EVIDENCE_BUCKET}`, () => s3.send(new PutBucketCorsCommand({
    Bucket: EVIDENCE_BUCKET,
    CORSConfiguration: { CORSRules: [{ AllowedMethods: ['PUT', 'GET'], AllowedOrigins: ['*'], AllowedHeaders: ['*'], MaxAgeSeconds: 3000 }] },
  })));

  console.log('\nGlue');
  await step(`database ${GLUE_DATABASE}`, () => glue.send(new CreateDatabaseCommand({ DatabaseInput: { Name: GLUE_DATABASE } })));
  if (!LAB_ROLE) {
    console.log('  skipped  crawler (set LAB_ROLE_ARN in .env - copy the LabRole ARN from IAM)');
  } else {
    await step(`crawler ${GLUE_CRAWLER}`, () => glue.send(new CreateCrawlerCommand({
      Name: GLUE_CRAWLER,
      Role: LAB_ROLE,
      DatabaseName: GLUE_DATABASE,
      Targets: { S3Targets: [{ Path: `s3://${ANALYTICS_BUCKET}/ledger/` }] },
      TablePrefix: '',
    })));
  }

  console.log('\nDone. Remaining console steps: Lambda + API Gateway + Beanstalk + CloudFront (see README).');
}

main();
