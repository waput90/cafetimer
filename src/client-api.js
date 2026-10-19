const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const { X509Certificate } = require('node:crypto');
const { PORT } = require('./server-api');

function validateConfig(ip, fingerprint) {
  if (net.isIP(String(ip || '')) !== 4) throw new Error('Enter the server IPv4 address.');
  const normalized = String(fingerprint || '').replaceAll(':', '').replaceAll(' ', '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(normalized)) throw new Error('Enter the 64-character server certificate fingerprint.');
  return { ip, fingerprint: normalized };
}

function verifyPinnedCertificate(socket, fingerprint) {
  const peer = socket.getPeerCertificate(true);
  if (!peer?.raw) throw new Error('Server certificate missing.');
  const cert = new X509Certificate(peer.raw);
  if (cert.fingerprint256.replaceAll(':', '').toUpperCase() !== fingerprint) {
    throw new Error('Server fingerprint does not match. Check it on the cashier screen.');
  }
  if (Date.now() < Date.parse(cert.validFrom) || Date.now() > Date.parse(cert.validTo)) {
    throw new Error('Server certificate has expired.');
  }
  return cert;
}

function discoverFingerprint(ip, port) {
  if (net.isIP(String(ip || '')) !== 4) return Promise.reject(new Error('Enter the server IPv4 address.'));
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: ip, port, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    let finished = false;
    const finish = (error, fingerprint) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (error) reject(error); else resolve(fingerprint);
    };
    socket.setTimeout(5000, () => finish(new Error('Server connection timed out.')));
    socket.once('secureConnect', () => {
      try {
        const peer = socket.getPeerCertificate(true);
        if (!peer?.raw) throw new Error('Server certificate missing.');
        const cert = new X509Certificate(peer.raw);
        if (Date.now() < Date.parse(cert.validFrom) || Date.now() > Date.parse(cert.validTo)) {
          throw new Error('Server certificate has expired.');
        }
        finish(null, cert.fingerprint256.replaceAll(':', '').toUpperCase());
      } catch (error) { finish(error); }
    });
    socket.once('error', finish);
  });
}

class PinnedAgent extends https.Agent {
  constructor(config, port) {
    super({ keepAlive: false, maxSockets: 1 });
    this.config = config;
    this.port = port;
  }

  createConnection(_options, callback) {
    const socket = tls.connect({
      host: this.config.ip,
      port: this.port,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2'
    });
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      if (error) socket.destroy();
      callback(error || null, error ? undefined : socket);
    };
    socket.setTimeout(5000, () => finish(new Error('Server connection timed out.')));
    socket.once('secureConnect', () => {
      try {
        verifyPinnedCertificate(socket, this.config.fingerprint);
        socket.setTimeout(0);
        finish();
      } catch (error) {
        finish(error);
      }
    });
    socket.once('error', finish);
  }
}

class ClientApi {
  constructor(filePath, deviceId, port = PORT, saveConfig = null) {
    this.filePath = filePath;
    this.deviceId = deviceId;
    this.port = port;
    this.saveConfig = saveConfig || ((config) => {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(config), { mode: 0o600 });
    });
    this.token = null;
    this.deviceName = null;
    this.profile = null;
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      this.config = validateConfig(saved.ip, saved.fingerprint);
    }
    catch { this.config = null; }
  }

  async request(method, route, payload = {}, config = this.config) {
    if (!config) throw new Error('Enter the server IP first.');
    return new Promise((resolve, reject) => {
      const agent = new PinnedAgent(config, this.port);
      const request = https.request({ host: config.ip, port: this.port, path: route, method, agent, timeout: 5000,
        headers: { 'Content-Type': 'application/json' } }, (response) => {
        let raw = '';
        response.on('data', (chunk) => { raw += chunk; if (raw.length > 16384) request.destroy(new Error('Server response too large.')); });
        response.on('end', () => {
          agent.destroy();
          try {
            const value = JSON.parse(raw);
            if (response.statusCode !== 200) reject(new Error(value.error || 'Server request failed.'));
            else resolve(value);
          } catch (error) { reject(error); }
        });
      });
      request.once('timeout', () => request.destroy(new Error('Server connection timed out.')));
      request.once('error', (error) => { agent.destroy(); reject(error); });
      request.end(method === 'POST' ? JSON.stringify(payload) : undefined);
    });
  }

  async setup(ip) {
    ip = String(ip || '').trim();
    const fingerprint = await discoverFingerprint(ip, this.port);
    const config = validateConfig(ip, fingerprint);
    await this.request('GET', '/health', {}, config);
    const presence = await this.request('POST', '/presence', { deviceId: this.deviceId }, config);
    this.saveConfig(config);
    this.config = config;
    this.deviceName = presence.name;
    this.token = null;
    this.profile = null;
    return true;
  }

  register(username, password) { return this.request('POST', '/register', { username, password }); }

  async presence() {
    const value = await this.request('POST', '/presence', { deviceId: this.deviceId });
    this.deviceName = value.name;
    return value;
  }

  async login(username, password) {
    const value = await this.request('POST', '/login', { username, password, deviceId: this.deviceId });
    this.token = value.token;
    return this.status();
  }

  async status() {
    if (!this.token) throw new Error('Login required.');
    this.profile = await this.request('POST', '/status', { token: this.token, deviceId: this.deviceId });
    return this.profile;
  }

  async logout() {
    try { if (this.token) await this.request('POST', '/logout', { token: this.token, deviceId: this.deviceId }); }
    finally { this.token = null; this.profile = null; }
  }

  async topup(amountCents) {
    if (!this.token) throw new Error('Login required.');
    await this.request('POST', '/topup', { token: this.token, deviceId: this.deviceId, amountCents });
    return this.status();
  }
}

module.exports = { ClientApi, PinnedAgent, discoverFingerprint, validateConfig, verifyPinnedCertificate };
