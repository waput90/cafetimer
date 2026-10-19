const ACTIVE_STATUSES = new Set(['active', 'paused']);

function createStations(count = 12) {
  return Array.from({ length: count }, (_, index) => ({
    id: `PC-${String(index + 1).padStart(2, '0')}`,
    name: `Station ${String(index + 1).padStart(2, '0')}`,
    status: 'available',
    customer: null,
    startedAt: null,
    endsAt: null,
    pausedAt: null,
    pausedRemainingMs: null,
    openTime: false,
    sessionId: null,
    accessCodeHash: null,
    message: null
  }));
}

function remainingSeconds(station, now = Date.now()) {
  if (station.status === 'paused') {
    return station.openTime ? null : Math.max(0, Math.ceil((station.pausedRemainingMs || 0) / 1000));
  }
  if (station.status !== 'active' || station.openTime || !station.endsAt) return null;
  return Math.max(0, Math.ceil((station.endsAt - now) / 1000));
}

function normalizeExpiredStations(state, now = Date.now()) {
  let changed = false;
  const stations = state.stations.map((station) => {
    if (station.status !== 'active' || station.openTime || !station.endsAt || station.endsAt > now) {
      return station;
    }
    changed = true;
    return {
      ...station,
      status: 'expired',
      endsAt: now,
      sessionId: null,
      accessCodeHash: null,
      pausedAt: null,
      pausedRemainingMs: 0
    };
  });
  return changed ? { ...state, stations } : state;
}

function publicState(state, now = Date.now()) {
  const normalized = normalizeExpiredStations(state, now);
  return {
    ...normalized,
    security: undefined,
    stations: normalized.stations.map((station) => ({
      ...station,
      accessCodeHash: undefined,
      sessionId: undefined,
      remainingSeconds: remainingSeconds(station, now)
    }))
  };
}

function canUseClient(state, stationId, authenticatedSessionId, now = Date.now()) {
  const station = state.stations.find((item) => item.id === stationId);
  return Number.isFinite(state.heartbeatAt) && now - state.heartbeatAt >= 0
    && now - state.heartbeatAt < 5000 && station?.status === 'active'
    && Boolean(station.sessionId) && station.sessionId === authenticatedSessionId;
}

function updateStation(state, stationId, updater) {
  const index = state.stations.findIndex((station) => station.id === stationId);
  if (index < 0) throw new Error('Station not found.');
  const stations = [...state.stations];
  stations[index] = updater({ ...stations[index] });
  return { ...state, stations };
}

function applyStationAction(state, action, now = Date.now()) {
  const stationId = String(action?.stationId || '');
  switch (action?.type) {
    case 'start': {
      const minutes = Number(action.minutes);
      const openTime = Boolean(action.openTime);
      if (!openTime && (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440)) {
        throw new Error('Session length must be between 1 and 1440 minutes.');
      }
      const customer = String(action.customer || 'Walk-in').trim().slice(0, 50) || 'Walk-in';
      return updateStation(state, stationId, (station) => ({
        ...station,
        status: 'active',
        customer,
        startedAt: now,
        endsAt: openTime ? null : now + Math.round(minutes * 60_000),
        pausedAt: null,
        pausedRemainingMs: null,
        openTime,
        sessionId: null,
        accessCodeHash: null,
        message: null
      }));
    }
    case 'pause':
      return updateStation(state, stationId, (station) => {
        if (station.status !== 'active') throw new Error('Only an active session can be paused.');
        return {
          ...station,
          status: 'paused',
          pausedAt: now,
          pausedRemainingMs: station.openTime ? null : Math.max(0, station.endsAt - now)
        };
      });
    case 'resume':
      return updateStation(state, stationId, (station) => {
        if (station.status !== 'paused') throw new Error('Only a paused session can be resumed.');
        return {
          ...station,
          status: 'active',
          endsAt: station.openTime ? null : now + Math.max(0, station.pausedRemainingMs || 0),
          pausedAt: null,
          pausedRemainingMs: null
        };
      });
    case 'extend': {
      const minutes = Number(action.minutes);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
        throw new Error('Extension must be between 1 and 1440 minutes.');
      }
      return updateStation(state, stationId, (station) => {
        if (!ACTIVE_STATUSES.has(station.status) || station.openTime) {
          throw new Error('This session cannot be extended.');
        }
        if (station.status === 'paused') {
          return { ...station, pausedRemainingMs: (station.pausedRemainingMs || 0) + minutes * 60_000 };
        }
        return { ...station, endsAt: Math.max(now, station.endsAt || now) + minutes * 60_000 };
      });
    }
    case 'stop':
      return updateStation(state, stationId, (station) => ({
        ...station,
        status: 'available',
        customer: null,
        startedAt: null,
        endsAt: null,
        pausedAt: null,
        pausedRemainingMs: null,
        openTime: false,
        sessionId: null,
        accessCodeHash: null,
        message: null
      }));
    case 'message': {
      const message = String(action.message || '').trim().slice(0, 180);
      return updateStation(state, stationId, (station) => ({ ...station, message: message || null }));
    }
    default:
      throw new Error('Unsupported station action.');
  }
}

module.exports = {
  ACTIVE_STATUSES,
  applyStationAction,
  canUseClient,
  createStations,
  normalizeExpiredStations,
  publicState,
  remainingSeconds
};
