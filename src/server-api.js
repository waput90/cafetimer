const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const selfsigned = require('selfsigned');

const PORT = 46321;
const MAX_BODY = 8192;

async function loadIdentity(dataRoot) {
  const filePath = path.join(dataRoot, 'admin', 'server-identity.json');
  let identity;
  try { identity = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const generated = await selfsigned.generate([{ name: 'commonName', value: 'CafeTimer Server' }], { days: 3650, keySize: 2048 });
    identity = { cert: generated.cert, private: generated.private };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
  }
  const fingerprint = new crypto.X509Certificate(identity.cert).fingerprint256.replaceAll(':', '').toUpperCase();
  return { ...identity, fingerprint };
}

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(payload));
}

function body(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) { reject(new Error('Request too large.')); request.destroy(); }
    });
    request.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON.')); }
    });
    request.on('error', reject);
  });
}

function startServer(identity, db, host = '0.0.0.0', port = PORT) {
  const attempts = new Map();
  const server = https.createServer({ key: identity.private, cert: identity.cert, minVersion: 'TLSv1.2' }, async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') return json(response, 200, { service: 'CafeTimer', version: 1 });
      const key = request.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const entry = attempts.get(key) || { count: 0, until: 0 };
      if (now < entry.until) return json(response, 429, { error: 'Too many attempts. Try again later.' });
      if (request.method !== 'POST') return json(response, 404, { error: 'Not found.' });
      const data = await body(request);
      let result;
      switch (request.url) {
        case '/register': result = db.register(data.username, data.password); break;
        case '/login': result = { token: db.login(data.username, data.password, data.deviceId || data.stationId) }; break;
        case '/presence': result = db.presence(data.deviceId || data.stationId); break;
        case '/status': result = db.status(data.token, data.deviceId || data.stationId); break;
        case '/logout': db.logout(data.token, data.deviceId || data.stationId); result = { ok: true }; break;
        case '/topup': result = db.requestTopup(data.token, data.deviceId || data.stationId, data.amountCents); break;
        default: return json(response, 404, { error: 'Not found.' });
      }
      attempts.delete(key);
      return json(response, 200, result);
    } catch (error) {
      const key = request.socket.remoteAddress || 'unknown';
      const previous = attempts.get(key) || { count: 0, until: 0 };
      const count = previous.count + 1;
      attempts.set(key, { count: count >= 5 ? 0 : count, until: count >= 5 ? Date.now() + 30000 : 0 });
      return json(response, 400, { error: error.message || 'Request failed.' });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server); });
  });
}

module.exports = { loadIdentity, startServer, PORT };
