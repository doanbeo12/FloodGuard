const express = require('express');
const path = require('path');

const app = express();
const port = Number(process.env.PORT || 8080);
const apiBaseUrl = String(
  process.env.API_BASE_URL || 'http://localhost:3001'
).replace(/\/$/, '');

app.get('/config.js', (_req, res) => {
  res
    .type('application/javascript')
    .set('Cache-Control', 'no-store')
    .send(`window.FLOODGUARD_API_BASE_URL=${JSON.stringify(apiBaseUrl)};`);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, dashboard: '1.5.4', apiBaseUrlConfigured: Boolean(apiBaseUrl) });
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`FloodGuard Dashboard v1.5.4 listening on ${port}`);
});