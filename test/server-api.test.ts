// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const selfsigned = require('selfsigned');
const { AccountDb } = require('../src/account-db');
const { ClientApi } = require('../src/client-api');
const { startServer } = require('../src/server-api');

test('client pins server certificate before account requests', async () => {
  const generated = await selfsigned.generate([{ name: 'commonName', value: 'CafeTimer Server' }], { days: 1, keySize: 2048 });
  const identity = { cert: generated.cert, private: generated.private };
  const db = new AccountDb(':memory:');
  const server = await startServer(identity, db, '127.0.0.1', 0);
  try {
    const api = new ClientApi(':memory:', 'device-network-test', server.address().port, () => {});
    await api.setup('127.0.0.1');
    assert.equal((await api.request('GET', '/health')).service, 'CafeTimer');
    assert.equal((await api.presence()).ok, true);
    assert.deepEqual(db.adminState().connectedStations.map((item) => item.deviceId), ['device-network-test']);
    await assert.rejects(api.request('POST', '/login', { username: 'missing', password: 'wrong', deviceId: 'device-network-test' }), /Invalid username or password/);
    await api.register('network_user', 'long-network-password');
    await assert.rejects(api.login('network_user', 'long-network-password'), /approval/);
    db.reviewAccount(db.adminState().accounts[0].id, true);
    await api.login('network_user', 'long-network-password');
    assert.equal(api.profile.accessAllowed, false);
    await api.topup(1000);
    db.reviewTopup(db.adminState().topupRequests[0].id, true);
    assert.equal((await api.status()).accessAllowed, true);
    await api.logout();
    assert.equal(api.token, null);
    api.config.fingerprint = '0'.repeat(64);
    await assert.rejects(api.request('GET', '/health'), /fingerprint does not match/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
