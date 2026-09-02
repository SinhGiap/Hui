'use strict';
// Lambda entry point. One function serves every route behind an API Gateway
// {proxy+} resource.
// ponytail: a single "Lambda-lith" instead of a function per endpoint. One zip,
// one role, one set of logs, and the routing table in routes.js reads like an
// Express app. Split a route out only if its memory or timeout needs diverge.
const { dispatch, HttpError } = require('./routes');
const { exportHandler } = require('./analytics');

const CORS = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json',
};

const reply = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  // API Gateway HTTP API sends payload v2.0, REST API sends v1.0. Read both so
  // the same zip works whichever the Learner Lab account allows.
  const isV2 = event.version === '2.0';
  const method = isV2 ? event.requestContext.http.method : event.httpMethod;
  const rawPath = isV2 ? event.requestContext.http.path : event.path;

  if (method === 'OPTIONS') return reply(204, {});

  // Strip the API Gateway stage prefix (/prod/groups -> /groups).
  const stage = event.requestContext?.stage;
  const path = stage && stage !== '$default' && rawPath.startsWith(`/${stage}/`)
    ? rawPath.slice(stage.length + 1)
    : rawPath;

  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));

  let body = {};
  if (event.body) {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, { error: 'request body must be valid JSON' });
    }
  }

  try {
    const result = await dispatch({
      method,
      path,
      body,
      query: event.queryStringParameters || {},
      authorization: headers.authorization,
    });
    return reply(200, result);
  } catch (e) {
    if (e instanceof HttpError) return reply(e.status, { error: e.message });
    console.error('unhandled', e);
    return reply(500, { error: 'internal error' });
  }
};

// EventBridge nightly target: same deployment package, different handler path
// (api/index.nightlyExport).
exports.nightlyExport = async () => {
  const result = await exportHandler();
  console.log('nightly export', result);
  return result;
};
