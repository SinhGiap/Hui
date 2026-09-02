'use strict';
// Single-table DynamoDB design. Key shapes:
//   USER#<id>  | PROFILE            -> account + reliability counters
//   EMAIL#<em> | USER               -> email uniqueness + login lookup
//   GROUP#<id> | META               -> group settings, payout order, due dates
//   GROUP#<id> | MEMBER#<userId>    -> membership + payout position
//   USER#<id>  | GROUP#<groupId>    -> mirror row, powers "my groups"
//   GROUP#<id> | CONTRIB#<cycle>#<userId> -> the ledger
// ponytail: mirror rows instead of a GSI. Two writes beats an index to provision,
// backfill and pay for. Add a GSI when a query appears that mirroring cannot serve.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, TransactWriteCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const TABLE = process.env.TABLE_NAME || 'rosca';

// Set DYNAMO_ENDPOINT to run against DynamoDB Local (see README). The dummy
// credentials are required because the SDK refuses to sign without any, and
// DynamoDB Local ignores their value.
const local = process.env.DYNAMO_ENDPOINT;
const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'us-east-1',
  ...(local ? { endpoint: local, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
});
const doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });

const get = async (PK, SK) => (await doc.send(new GetCommand({ TableName: TABLE, Key: { PK, SK } }))).Item || null;
const put = (Item, ConditionExpression) => doc.send(new PutCommand({ TableName: TABLE, Item, ConditionExpression }));
const update = (params) => doc.send(new UpdateCommand({ TableName: TABLE, ...params }));
const transact = (TransactItems) => doc.send(new TransactWriteCommand({ TransactItems }));

async function query(PK, skPrefix) {
  const out = await doc.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: skPrefix ? '#pk = :pk AND begins_with(#sk, :sk)' : '#pk = :pk',
    ExpressionAttributeNames: skPrefix ? { '#pk': 'PK', '#sk': 'SK' } : { '#pk': 'PK' },
    ExpressionAttributeValues: skPrefix ? { ':pk': PK, ':sk': skPrefix } : { ':pk': PK },
  }));
  return out.Items || [];
}

// Only the nightly analytics export uses this. Everything user-facing queries by key.
async function scanAll(skPrefix) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await doc.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'begins_with(#sk, :sk)',
      ExpressionAttributeNames: { '#sk': 'SK' },
      ExpressionAttributeValues: { ':sk': skPrefix },
      ExclusiveStartKey,
    }));
    items.push(...(out.Items || []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

module.exports = { TABLE, doc, get, put, update, query, transact, scanAll };
