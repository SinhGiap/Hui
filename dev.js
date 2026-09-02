'use strict';
// Local stand-in for API Gateway. Wraps the exact same dispatch() the Lambda
// uses, so what runs on your laptop is the deployed code path minus the gateway.
// Point it at the Learner Lab's real DynamoDB (npm run create-table first).
const express = require('express');
const { dispatch, HttpError } = require('./api/routes');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.all('*', async (req, res) => {
  try {
    res.json(await dispatch({
      method: req.method,
      path: req.path,
      body: req.body,
      query: req.query,
      authorization: req.get('authorization'),
    }));
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

const port = process.env.API_PORT || 4000;
app.listen(port, () => console.log(`API on http://localhost:${port}`));
