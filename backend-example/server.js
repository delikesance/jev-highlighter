// Backend minimal (production) : l'extension appelle CE serveur, qui seul détient la clé JEV.
//   JEV_API_KEY=... ALLOWED_ORIGIN=chrome-extension://<id> node backend-example/server.js
// À ajouter en vrai : authentification de vos utilisateurs, quotas, validation du corps, logs.
const http = require('node:http');

const KEY = process.env.JEV_API_KEY;
const UPSTREAM = process.env.JEV_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';
const ORIGIN = process.env.ALLOWED_ORIGIN || '';
if (!KEY) throw new Error('JEV_API_KEY manquant');

const cors = {
  'Access-Control-Allow-Origin': ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

http
  .createServer((req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if (req.method !== 'POST') return res.writeHead(405, cors).end();
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const up = await fetch(UPSTREAM, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
          body: raw
        });
        res.writeHead(up.status, { 'Content-Type': 'application/json', ...cors });
        res.end(await up.text());
      } catch (e) {
        res.writeHead(502, cors).end(JSON.stringify({ error: 'upstream' }));
      }
    });
  })
  .listen(process.env.PORT || 8787, () => console.log('backend prêt'));
