const test = require('node:test');
const assert = require('node:assert/strict');
const { applyStationAction, canUseClient, createStations, normalizeExpiredStations, publicState, remainingSeconds } = require('../src/session-core');
const { hashPin, verifyPin, newAccessCode } = require('../src/security');

function state() {
  return { stations: createStations(2), security: hashPin('2468') };
}

test('starts a timed session and calculates remaining time', () => {
  const now = 1_000_000;
  const next = applyStationAction(state(), { type: 'start', stationId: 'PC-01', minutes: 60, customer: 'Alex' }, now);
  assert.equal(next.stations[0].status, 'active');
  assert.equal(next.stations[0].customer, 'Alex');
  assert.equal(remainingSeconds(next.stations[0], now + 30_000), 3570);
});

test('pause, extend and resume preserve the correct remaining duration', () => {
  const started = applyStationAction(state(), { type: 'start', stationId: 'PC-01', minutes: 30 }, 1000);
  const paused = applyStationAction(started, { type: 'pause', stationId: 'PC-01' }, 61_000);
  const extended = applyStationAction(paused, { type: 'extend', stationId: 'PC-01', minutes: 15 }, 90_000);
  const resumed = applyStationAction(extended, { type: 'resume', stationId: 'PC-01' }, 100_000);
  assert.equal(resumed.stations[0].endsAt, 2_740_000);
  assert.equal(remainingSeconds(resumed.stations[0], 100_000), 2640);
});

test('expired sessions are locked and security data is not exposed', () => {
  const started = applyStationAction(state(), { type: 'start', stationId: 'PC-01', minutes: 1 }, 0);
  const expired = normalizeExpiredStations(started, 60_001);
  const exposed = publicState(expired, 60_001);
  assert.equal(exposed.stations[0].status, 'expired');
  assert.equal(exposed.security, undefined);
});

test('admin pins are salted and verified with timing-safe comparison', () => {
  const credentials = hashPin('2468');
  assert.equal(verifyPin('2468', credentials), true);
  assert.equal(verifyPin('0000', credentials), false);
  assert.notEqual(credentials.hash, '2468');
});

test('rejects unsafe session lengths', () => {
  assert.throws(() => applyStationAction(state(), { type: 'start', stationId: 'PC-01', minutes: 0 }), /between 1 and 1440/);
});

test('client access needs a matching login, active session, and fresh cashier heartbeat', () => {
  const now = 100_000;
  const accessCode = newAccessCode();
  const started = applyStationAction(state(), { type: 'start', stationId: 'PC-01', minutes: 60 }, now);
  started.heartbeatAt = now;
  started.stations[0].sessionId = 'session-1';
  started.stations[0].accessCodeHash = hashPin(accessCode);
  assert.equal(canUseClient(started, 'PC-01', null, now), false);
  assert.equal(canUseClient(started, 'PC-01', 'session-1', now), true);
  assert.equal(canUseClient(started, 'PC-01', 'session-1', now + 5000), false);
  const paused = applyStationAction(started, { type: 'pause', stationId: 'PC-01' }, now + 1000);
  assert.equal(canUseClient(paused, 'PC-01', 'session-1', now + 1000), false);
  const stopped = applyStationAction(started, { type: 'stop', stationId: 'PC-01' }, now + 1000);
  assert.equal(stopped.stations[0].accessCodeHash, null);
  assert.equal(canUseClient(stopped, 'PC-01', 'session-1', now + 1000), false);
  const exposed = publicState(started, now);
  assert.equal(exposed.stations[0].accessCodeHash, undefined);
  assert.equal(exposed.stations[0].sessionId, undefined);
  assert.equal(verifyPin(accessCode, started.stations[0].accessCodeHash), true);
  assert.equal(verifyPin(newAccessCode(), started.stations[0].accessCodeHash), false);
});
