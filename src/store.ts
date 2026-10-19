// @ts-nocheck
const fs = require('node:fs');
const path = require('node:path');
const { createStations, normalizeExpiredStations } = require('./session-core');
const { hashPin } = require('./security');

function initialState() {
  return {
    version: 1,
    cafeName: 'NEXUS CAFE',
    currency: 'PHP',
    hourlyRate: 30,
    security: hashPin('2468'),
    pinChanged: false,
    heartbeatAt: 0,
    settings: {
      launchAtLogin: true
    },
    stations: createStations(12),
    activity: [
      { id: 'welcome', at: Date.now(), text: 'CafeTimer control center is ready.' }
    ]
  };
}

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(data.stations) || !data.security) throw new Error('Invalid data file');
      return normalizeExpiredStations(data);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const state = initialState();
      this.persist(state);
      return state;
    }
  }

  get() {
    this.state = normalizeExpiredStations(this.state);
    return this.state;
  }

  reload() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(data.stations) || !data.security) throw new Error('Invalid data file');
      this.state = normalizeExpiredStations(data);
      return true;
    } catch {
      return false;
    }
  }

  set(state) {
    this.state = state;
    this.persist(state);
    return state;
  }

  update(mutator) {
    return this.set(mutator(this.get()));
  }

  persist(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2));
    fs.renameSync(temporaryPath, this.filePath);
  }
}

module.exports = { JsonStore, initialState };
