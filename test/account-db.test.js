const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountDb } = require('../src/account-db');

test('registration approval, login, charging, and top-up review', () => {
  const db = new AccountDb(':memory:');
  assert.deepEqual(db.register('alex_1', 'long-test-password'), { status: 'pending' });
  assert.throws(() => db.login('alex_1', 'long-test-password', 'PC-01'), /approval/);
  const account = db.adminState().accounts[0];
  db.reviewAccount(account.id, true);
  const token = db.login('alex_1', 'long-test-password', 'PC-01');
  assert.equal(db.status(token, 'PC-01').accessAllowed, false);
  assert.throws(() => db.status(token, 'PC-02'), /Login required/);
  db.requestTopup(token, 'PC-01', 3000);
  assert.throws(() => db.requestTopup(token, 'PC-01', 3000), /pending/);
  const request = db.adminState().topupRequests[0];
  db.reviewTopup(request.id, true);
  assert.throws(() => db.reviewTopup(request.id, true), /not found/);
  const before = db.status(token, 'PC-01');
  assert.equal(before.accessAllowed, true);
  assert.ok(before.secondsRemaining > 3500);
  const row = db.session(token, 'PC-01');
  db.transaction(() => db.charge(row, row.last_charge_at + 60_000));
  const after = db.status(token, 'PC-01');
  assert.ok(after.balanceCents < before.balanceCents);
  db.logout(token, 'PC-01');
  assert.throws(() => db.status(token, 'PC-01'), /Login required/);
});

test('rejects unsafe account and top-up inputs', () => {
  const db = new AccountDb(':memory:');
  assert.throws(() => db.register('a', 'long-test-password'), /Username/);
  assert.throws(() => db.register('alex', 'short'), /Password/);
  db.register('alex', 'long-test-password');
  assert.throws(() => db.register('Alex', 'long-test-password'), /taken/);
  db.reviewAccount(db.adminState().accounts[0].id, true);
  const token = db.login('alex', 'long-test-password', 'PC-01');
  assert.throws(() => db.requestTopup(token, 'PC-01', -100), /Top-up/);
});

test('dashboard lists only recently connected workstations', () => {
  const db = new AccountDb(':memory:');
  assert.equal(db.adminState().connectedStations.length, 0);
  db.presence('device-test-01');
  assert.deepEqual(db.adminState().connectedStations.map((item) => item.deviceId), ['device-test-01']);
  db.renameWorkstation('device-test-01', 'Front desk PC');
  assert.equal(db.presence('device-test-01').name, 'Front desk PC');
  assert.equal(db.adminState().connectedStations[0].name, 'Front desk PC');
  assert.throws(() => db.presence('x'), /Invalid client/);
  db.db.prepare('UPDATE workstations SET last_seen_at=? WHERE station_id=?').run(Date.now() - 6000, 'device-test-01');
  assert.equal(db.adminState().connectedStations.length, 0);
});

test('stale client sessions stop charging and disappear', () => {
  const db = new AccountDb(':memory:');
  db.register('offline_user', 'long-test-password');
  db.reviewAccount(db.adminState().accounts[0].id, true);
  const token = db.login('offline_user', 'long-test-password', 'PC-01');
  db.requestTopup(token, 'PC-01', 1000);
  db.reviewTopup(db.adminState().topupRequests[0].id, true);
  db.db.prepare('UPDATE sessions SET last_seen_at=?,last_charge_at=?').run(Date.now() - 10000, Date.now() - 10000);
  db.adminState();
  assert.equal(db.adminState().sessions.length, 0);
  assert.throws(() => db.status(token, 'PC-01'), /Login required/);
});
