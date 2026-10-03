// Serveur de test local : sert la page fixture sur / et simule JEV sur POST /jev (aucune clé requise).
// Usage : npm run mock  -> ouvrir http://localhost:8787/ ; endpoint = http://localhost:8787/jev
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 8787;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

http
  .createServer((req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end();
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'fixture.html')));
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const { questions = {} } = JSON.parse(raw || '{}');
      console.log(`[mock] ${Object.keys(questions).length} questions`);
      const answers = {};
      for (const [id, q] of Object.entries(questions)) {
        if (q.type === 'noul') { answers[id] = { type: 'noul', noul: 0.3, confidence: 0.5 }; continue; }
        const keys = Object.keys(q.criteria);
        const raw = keys.map((_, i) => 1 / (i + 1.5)); // poids décroissants, déterministes
        const sum = raw.reduce((a, b) => a + b, 0);
        const probabilities = Object.fromEntries(keys.map((k, i) => [k, raw[i] / sum]));
        answers[id] = { type: 'choice', choice: keys[0], confidence: 0.6, probabilities, stats: {} };
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ model: 'mock', answers }));
    });
  })
  .listen(PORT, () => console.log(`[mock] http://localhost:${PORT}/`));
