const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashPin, verifyPin } = require('./security');

const RATE_CENTS_PER_HOUR = 3000;
const DENOMINATOR = 3_600_000;

function validateDeviceId(deviceId) {
  const value = String(deviceId || '').trim();
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(value)) throw new Error('Invalid client device ID.');
  return value;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

class AccountDb {
  constructor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        salt TEXT NOT NULL, password_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
        balance_microcents INTEGER NOT NULL DEFAULT 0 CHECK(balance_microcents >= 0),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
        station_id TEXT NOT NULL, last_charge_at INTEGER NOT NULL,
        charge_remainder INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS topups (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
        amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
        created_at INTEGER NOT NULL, reviewed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS workstations (
        station_id TEXT PRIMARY KEY, last_seen_at INTEGER NOT NULL
      );`);
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name);
    if (!columns.includes('last_seen_at')) this.db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0');
    const workstationColumns = this.db.prepare('PRAGMA table_info(workstations)').all().map((column) => column.name);
    if (!workstationColumns.includes('name')) this.db.exec('ALTER TABLE workstations ADD COLUMN name TEXT');
    // Client tokens live only in workstation memory, so a server restart invalidates them.
    this.db.exec('DELETE FROM sessions');
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  register(username, password) {
    username = String(username || '').trim();
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) throw new Error('Username must be 3 to 24 letters, numbers, or underscores.');
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new Error('Password must be 12 to 128 characters.');
    const credentials = hashPin(password);
    try {
      this.db.prepare('INSERT INTO users(username,salt,password_hash,status,created_at) VALUES(?,?,?,?,?)')
        .run(username, credentials.salt, credentials.hash, 'pending', Date.now());
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new Error('Username is already taken.');
      throw error;
    }
    return { status: 'pending' };
  }

  login(username, password, deviceId) {
    deviceId = validateDeviceId(deviceId);
    const user = this.db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').trim());
    if (!user || !verifyPin(password, { salt: user.salt, hash: user.password_hash })) throw new Error('Invalid username or password.');
    if (user.status !== 'approved') throw new Error('Account is waiting for administrator approval.');
    const token = crypto.randomBytes(32).toString('base64url');
    this.transaction(() => {
      const existing = this.db.prepare('SELECT token_hash FROM sessions WHERE user_id=?').get(user.id);
      if (existing) {
        const previous = this.sessionByHash(existing.token_hash);
        if (previous) this.charge(previous, Math.min(Date.now(), previous.last_seen_at + 5000));
      }
      this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      const now = Date.now();
      this.db.prepare('INSERT INTO sessions(token_hash,user_id,station_id,last_charge_at,last_seen_at) VALUES(?,?,?,?,?)')
        .run(tokenHash(token), user.id, deviceId, now, now);
    });
    return token;
  }

  session(token, deviceId) {
    deviceId = validateDeviceId(deviceId);
    if (typeof token !== 'string' || token.length < 32) throw new Error('Login required.');
    const row = this.db.prepare(`SELECT s.*,u.username,u.status,u.balance_microcents FROM sessions s
      JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.station_id=?`)
      .get(tokenHash(token), deviceId);
    if (!row || row.status !== 'approved' || Date.now() - row.last_seen_at > 5000) throw new Error('Login required.');
    return row;
  }

  charge(row, now = Date.now()) {
    const elapsed = Math.max(0, now - row.last_charge_at);
    const numerator = row.balance_microcents > 0
      ? BigInt(elapsed) * BigInt(RATE_CENTS_PER_HOUR) * 1_000_000n + BigInt(row.charge_remainder)
      : 0n;
    const calculated = numerator / BigInt(DENOMINATOR);
    const spent = Number(calculated > BigInt(row.balance_microcents) ? BigInt(row.balance_microcents) : calculated);
    const remaining = Math.max(0, row.balance_microcents - spent);
    this.db.prepare('UPDATE users SET balance_microcents=? WHERE id=?').run(remaining, row.user_id);
    this.db.prepare('UPDATE sessions SET last_charge_at=?,charge_remainder=? WHERE token_hash=?')
      .run(now, Number(numerator % BigInt(DENOMINATOR)), row.token_hash);
    return remaining;
  }

  status(token, deviceId) {
    return this.transaction(() => {
      const row = this.session(token, deviceId);
      const now = Date.now();
      const balance = this.charge(row, now);
      this.db.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?').run(now, row.token_hash);
      return {
        username: row.username,
        balanceCents: Math.floor(balance / 1_000_000),
        secondsRemaining: Number(BigInt(balance) * 3600n / (BigInt(RATE_CENTS_PER_HOUR) * 1_000_000n)),
        accessAllowed: balance > 0,
        topups: this.db.prepare('SELECT id,amount_cents AS amountCents,status,created_at AS createdAt FROM topups WHERE user_id=? ORDER BY id DESC LIMIT 10').all(row.user_id)
      };
    });
  }

  logout(token, deviceId) {
    const row = this.session(token, deviceId);
    this.transaction(() => {
      this.charge(row);
      this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(row.token_hash);
    });
  }

  requestTopup(token, deviceId, amountCents) {
    if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > 100000) throw new Error('Top-up must be between PHP 1 and PHP 1,000.');
    const row = this.session(token, deviceId);
    const existing = this.db.prepare("SELECT id FROM topups WHERE user_id=? AND status='pending'").get(row.user_id);
    if (existing) throw new Error('A top-up request is already pending.');
    this.db.prepare('INSERT INTO topups(user_id,amount_cents,status,created_at) VALUES(?,?,?,?)')
      .run(row.user_id, amountCents, 'pending', Date.now());
    return { status: 'pending' };
  }

  presence(deviceId) {
    deviceId = validateDeviceId(deviceId);
    const defaultName = `Client ${deviceId.slice(-6).toUpperCase()}`;
    this.db.prepare(`INSERT INTO workstations(station_id,name,last_seen_at) VALUES(?,?,?)
      ON CONFLICT(station_id) DO UPDATE SET name=COALESCE(workstations.name,excluded.name),last_seen_at=excluded.last_seen_at`).run(deviceId, defaultName, Date.now());
    const workstation = this.db.prepare('SELECT name FROM workstations WHERE station_id=?').get(deviceId);
    return { ok: true, name: workstation.name || defaultName };
  }

  renameWorkstation(deviceId, name) {
    deviceId = validateDeviceId(deviceId);
    name = String(name || '').trim();
    if (name.length < 1 || name.length > 32) throw new Error('Client name must be 1 to 32 characters.');
    const result = this.db.prepare('UPDATE workstations SET name=? WHERE station_id=?').run(name, deviceId);
    if (result.changes !== 1) throw new Error('Connected client not found.');
    return { ok: true, name };
  }

  adminState() {
    this.transaction(() => {
      const rows = this.db.prepare('SELECT * FROM sessions').all();
      for (const row of rows) {
        const joined = this.sessionByHash(row.token_hash);
        if (!joined) continue;
        const cutoff = row.last_seen_at + 5000;
        this.charge(joined, Math.min(Date.now(), cutoff));
        if (Date.now() > cutoff) this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(row.token_hash);
      }
    });
    return {
      accounts: this.db.prepare('SELECT id,username,status,balance_microcents AS balanceMicrocents,created_at AS createdAt FROM users ORDER BY id DESC').all(),
      connectedStations: this.db.prepare('SELECT station_id AS deviceId,name FROM workstations WHERE last_seen_at>? ORDER BY name,station_id').all(Date.now() - 5000),
      topupRequests: this.db.prepare(`SELECT t.id,t.amount_cents AS amountCents,t.created_at AS createdAt,u.username
        FROM topups t JOIN users u ON u.id=t.user_id WHERE t.status='pending' ORDER BY t.id`).all(),
      sessions: this.db.prepare('SELECT s.station_id AS deviceId,u.username,u.balance_microcents AS balanceMicrocents FROM sessions s JOIN users u ON u.id=s.user_id').all()
    };
  }

  sessionByHash(hash) {
    return this.db.prepare('SELECT s.*,u.username,u.status,u.balance_microcents FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(hash);
  }

  reviewAccount(id, approve) {
    const result = this.db.prepare("UPDATE users SET status=? WHERE id=? AND status='pending'")
      .run(approve ? 'approved' : 'rejected', id);
    if (result.changes !== 1) throw new Error('Pending account not found.');
  }

  reviewTopup(id, approve) {
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM topups WHERE id=? AND status='pending'").get(id);
      if (!row) throw new Error('Pending top-up not found.');
      this.db.prepare('UPDATE topups SET status=?,reviewed_at=? WHERE id=?')
        .run(approve ? 'approved' : 'rejected', Date.now(), id);
      if (approve) this.db.prepare('UPDATE users SET balance_microcents=balance_microcents+? WHERE id=?')
        .run(row.amount_cents * 1_000_000, row.user_id);
    });
  }
}

module.exports = { AccountDb, RATE_CENTS_PER_HOUR, validateDeviceId };
