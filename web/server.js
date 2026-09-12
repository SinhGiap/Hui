'use strict';
// The Elastic Beanstalk tier: serves the interface and nothing else. All data is
// fetched by the browser from API Gateway, so the tiers deploy independently.
const path = require('path');
const express = require('express');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Injected rather than hardcoded: the API base differs between dev and deployed.
const config = {
  apiBase: process.env.API_BASE || 'http://localhost:4000',
  cdnDomain: process.env.CDN_DOMAIN || '',
};
app.use((req, res, next) => { res.locals.config = config; next(); });

app.get('/', (req, res) => res.render('signin'));
app.get('/dashboard', (req, res) => res.render('dashboard'));
app.get('/profile', (req, res) => res.render('profile'));
app.get('/group/:id', (req, res) => res.render('group', { groupId: req.params.id }));

// An explicit endpoint makes a failing deploy obvious in the console.
app.get('/health', (req, res) => res.json({ ok: true, apiBase: config.apiBase }));

app.use((req, res) => res.status(404).render('signin'));

// Beanstalk's Node platform proxies to whatever PORT it sets, defaulting to 8080.
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`web on http://localhost:${port} -> API ${config.apiBase}`));
