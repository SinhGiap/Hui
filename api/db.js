'use strict';
// Single-table DynamoDB design. Key shapes:
//   USER#<id>  | PROFILE            -> account + reliability counters
//   EMAIL#<em> | USER               -> email uniqueness + login lookup
//   GROUP#<id> | META               -> group settings, payout order, due dates
//   GROUP#<id> | MEMBER#<userId>    -> membership + payout position
//   USER#<id>  | GROUP#<groupId>    -> mirror row, powers "my groups"
//   GROUP#<id> | CONTRIB#<cycle>#<userId> -> the ledger
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand, TransactWriteCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const TABLE = process.env.TABLE_NAME || 'rosca';

// DYNAMO_ENDPOINT runs against DynamoDB Local. The dummy credentials exist only
// because the SDK refuses to sign without any.
const local = process.env.DYNAMO_ENDPOINT;
const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'us-east-1',
  ...(local ? { endpoint: local, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
});
const doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });

const get = async (PK, SK) => (await doc.send(new GetCommand({ TableName: TABLE, Key: { PK, SK } }))).Item || null;
const put = (Item, ConditionExpression) => doc.send(new PutCommand({ TableName: TABLE, Item, ConditionExpression }));
const update = (params) => doc.send(new UpdateCommand({ TableName: TABLE, ...params }));
const del = (PK, SK) => doc.send(new DeleteCommand({ TableName: TABLE, Key: { PK, SK } }));
const transact = (TransactItems) => doc.send(new TransactWriteCommand({ TransactItems }));

// Query returns at most 1 MB per call. A circle is capped at 30 members so its
// ledger stays well inside that today, but an un-paged read silently truncates
// rather than failing, so follow the cursor.
async function query(PK, skPrefix) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await doc.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: skPrefix ? '#pk = :pk AND begins_with(#sk, :sk)' : '#pk = :pk',
      ExpressionAttributeNames: skPrefix ? { '#pk': 'PK', '#sk': 'SK' } : { '#pk': 'PK' },
      ExpressionAttributeValues: skPrefix ? { ':pk': PK, ':sk': skPrefix } : { ':pk': PK },
      ExclusiveStartKey,
    }));
    items.push(...(out.Items || []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// Only the nightly analytics export uses this. Everything user-facing queries by key.
async function scanAll(skPrefix) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await doc.send(new ScanCommand({
      TableName: TABLE,
      // No prefix means every row - begins_with on an empty string is not a
      // valid filter, so drop the expression rather than pass one.
      ...(skPrefix ? {
        FilterExpression: 'begins_with(#sk, :sk)',
        ExpressionAttributeNames: { '#sk': 'SK' },
        ExpressionAttributeValues: { ':sk': skPrefix },
      } : {}),
      ExclusiveStartKey,
    }));
    items.push(...(out.Items || []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

module.exports = { TABLE, get, put, update, del, query, transact, scanAll };
