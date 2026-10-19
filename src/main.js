const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { app, BrowserWindow, ipcMain, screen, session } = require('electron');
const { pathToFileURL } = require('node:url');
const { JsonStore } = require('./store');
const { publicState } = require('./session-core');
const { hashPin, verifyPin } = require('./security');
const { AccountDb } = require('./account-db');
const { loadIdentity, startServer, PORT } = require('./server-api');
const { ClientApi } = require('./client-api');
const { autoUpdater } = require('electron-updater');

const cafeDataRoot = path.join(app.getPath('appData'), 'CafeTimer');
const roleFile = path.join(cafeDataRoot, 'install-role.json');
let savedRole = null;
try { savedRole = JSON.parse(fs.readFileSync(roleFile, 'utf8')); } catch { /* First launch. */ }
const clientArgument = process.argv.find((arg) => arg.startsWith('--client='));
const runMode = clientArgument ? 'client' : ['admin', 'client'].includes(savedRole?.role) ? savedRole.role : app.isPackaged ? 'setup' : 'admin';
let clientDeviceId = clientArgument ? clientArgument.slice('--client='.length).trim() : savedRole?.deviceId || savedRole?.stationId;
if (runMode === 'client' && !clientDeviceId) {
  clientDeviceId = `device-${crypto.randomUUID()}`;
}
if (runMode === 'client' && !clientArgument && !savedRole?.deviceId) {
  fs.mkdirSync(cafeDataRoot, { recursive: true });
  fs.writeFileSync(roleFile, JSON.stringify({ role: 'client', deviceId: clientDeviceId }));
}
if (runMode === 'client' && !/^[A-Za-z0-9_-]{3,64}$/.test(clientDeviceId)) {
  throw new Error('Invalid client device ID.');
}
const indexPath = path.join(__dirname, 'renderer', 'index.html');
const trustedUrl = pathToFileURL(indexPath).toString();

// A workstation and the admin console may run together during provisioning/testing,
// while duplicate instances of the same role are still rejected.
app.setPath('userData', path.join(cafeDataRoot, runMode === 'client' ? 'client' : runMode));

let mainWindow;
let store;
let accountDb;
let clientApi;
let serverIdentity;
let serverError = null;
let clientStatusAt = 0;
let clientPollBusy = false;
let lastClientPresentation = null;
let adminAuthorized = false;
let failedAdminLogins = 0;
let adminBlockedUntil = 0;
let allowClientExit = false;
let updateState = { status: 'idle', currentVersion: app.getVersion() };

const gotSingleInstanceLock = app.requestSingleInstanceLock({ mode: runMode, deviceId: clientDeviceId });
if (!gotSingleInstanceLock) app.quit();

function validateSender(event) {
  const senderUrl = event.senderFrame?.url;
  if (!mainWindow || event.sender !== mainWindow.webContents
    || event.senderFrame !== event.sender.mainFrame
    || !senderUrl || new URL(senderUrl).pathname !== new URL(trustedUrl).pathname
    || new URL(senderUrl).protocol !== 'file:') throw new Error('Untrusted IPC sender.');
}

function addActivity(state, text) {
  const activity = [
    { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, at: Date.now(), text },
    ...(state.activity || [])
  ].slice(0, 40);
  return { ...state, activity };
}

function getPublicState() {
  if (runMode === 'setup') return {};
  if (runMode === 'client') return { cafeName: 'CafeTimer', stations: [] };
  if (!adminAuthorized) return { cafeName: store.get().cafeName, pinChanged: store.get().pinChanged, stations: [] };
  return { ...publicState(store.get()), ...accountDb.adminState() };
}

function clientMayUse() {
  return Boolean(clientApi?.profile?.accessAllowed && Date.now() - clientStatusAt < 5000);
}

function serverAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((item) => item.family === 'IPv4' && !item.internal).map((item) => item.address);
}

function clientSnapshot() {
  return { configured: Boolean(clientApi?.config), ip: clientApi?.config?.ip || null,
    name: clientApi?.deviceName || null,
    profile: clientApi?.profile || null, online: Boolean(clientApi?.profile && Date.now() - clientStatusAt < 5000),
    error: serverError };
}

function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const state = getPublicState();
  mainWindow.webContents.send('state:changed', {
    state,
    clientAuthorized: runMode === 'client' && clientMayUse(),
    adminAuthorized: runMode === 'admin' && adminAuthorized,
    client: runMode === 'client' ? clientSnapshot() : null,
    server: runMode === 'admin' && adminAuthorized ? { addresses: serverAddresses(), port: PORT, fingerprint: serverIdentity?.fingerprint } : null
  });
  if (runMode === 'client') applyClientPresentation(state);
}

function broadcastUpdateState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:changed', updateState);
}

function initializeUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => {
    updateState = { ...updateState, status: 'checking' };
    broadcastUpdateState();
  });
  autoUpdater.on('update-available', (info) => {
    updateState = { ...updateState, status: 'available', version: info.version };
    broadcastUpdateState();
  });
  autoUpdater.on('update-not-available', () => {
    updateState = { status: 'idle', currentVersion: app.getVersion() };
    broadcastUpdateState();
  });
  autoUpdater.on('download-progress', (progress) => {
    updateState = { ...updateState, status: 'downloading', percent: Math.round(progress.percent) };
    broadcastUpdateState();
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateState = { ...updateState, status: 'downloaded', version: info.version, percent: 100 };
    broadcastUpdateState();
  });
  autoUpdater.on('error', (error) => {
    updateState = { ...updateState, status: 'error', error: error.message };
    broadcastUpdateState();
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 10000).unref();
  setInterval(check, 6 * 60 * 60 * 1000).unref();
}

function applyClientPresentation(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const compact = clientMayUse();
  const presentation = !clientApi?.config ? 'setup' : compact ? 'compact' : 'locked';
  if (presentation === lastClientPresentation) return;
  lastClientPresentation = presentation;

  if (presentation === 'setup') {
    const display = screen.getPrimaryDisplay().workArea;
    const width = Math.min(800, display.width);
    const height = Math.min(650, display.height);
    mainWindow.setKiosk(false);
    mainWindow.setFullScreen(false);
    mainWindow.setResizable(true);
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setSkipTaskbar(false);
    mainWindow.setBounds({ x: display.x + Math.floor((display.width - width) / 2), y: display.y + Math.floor((display.height - height) / 2), width, height });
    return;
  }

  if (presentation === 'compact') {
    const display = screen.getPrimaryDisplay().workArea;
    const width = 460;
    const height = 144;
    mainWindow.setKiosk(false);
    mainWindow.setFullScreen(false);
    mainWindow.setResizable(false);
    mainWindow.setBounds({ x: display.x + display.width - width - 18, y: display.y + 18, width, height });
    mainWindow.setAlwaysOnTop(true, 'floating');
    mainWindow.setSkipTaskbar(true);
  } else {
    const display = screen.getPrimaryDisplay().bounds;
    mainWindow.setBounds(display);
    mainWindow.setSkipTaskbar(false);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setKiosk(true);
    mainWindow.focus();
  }
}

function secureWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.on('before-input-event', (event, input) => {
    const blocked = input.key === 'F5'
      || input.key === 'F11'
      || (input.control && ['r', 'R', 'u', 'U'].includes(input.key))
      || (input.control && input.shift && ['i', 'I', 'j', 'J', 'c', 'C'].includes(input.key));
    if (blocked) event.preventDefault();
  });
}

function createWindow() {
  const isClient = runMode === 'client';
  mainWindow = new BrowserWindow({
    width: runMode === 'setup' ? 800 : isClient ? 1280 : 1440,
    height: runMode === 'setup' ? 600 : isClient ? 800 : 900,
    minWidth: isClient || runMode === 'setup' ? undefined : 1120,
    minHeight: isClient || runMode === 'setup' ? undefined : 720,
    show: false,
    frame: !isClient,
    backgroundColor: '#09100f',
    autoHideMenuBar: true,
    title: isClient ? 'CafeTimer Client' : 'CafeTimer Control Center',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !isClient && !app.isPackaged
    }
  });

  secureWindow(mainWindow);
  mainWindow.loadFile(indexPath, { query: { mode: runMode } });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isClient) applyClientPresentation(getPublicState());
  });

  if (isClient) mainWindow.on('close', (event) => {
    if (clientApi?.config && !allowClientExit) event.preventDefault();
  });
}

function configureAutoStart(enabled) {
  if (!app.isPackaged || runMode === 'setup') return false;
  const args = [];
  app.setLoginItemSettings({ openAtLogin: enabled, enabled, path: process.execPath, args });
  return app.getLoginItemSettings({ path: process.execPath, args }).openAtLogin;
}

function registerIpc() {
  ipcMain.handle('app:bootstrap', (event) => {
    validateSender(event);
    return { mode: runMode, deviceId: clientDeviceId, state: getPublicState(),
      clientAuthorized: runMode === 'client' && clientMayUse(),
      adminAuthorized: runMode === 'admin' && adminAuthorized,
      client: runMode === 'client' ? clientSnapshot() : null,
      server: runMode === 'admin' && adminAuthorized ? { addresses: serverAddresses(), port: PORT, fingerprint: serverIdentity?.fingerprint } : null,
      packaged: app.isPackaged, update: updateState };
  });

  ipcMain.handle('update:download', async (event) => {
    validateSender(event);
    if (!app.isPackaged || updateState.status !== 'available') throw new Error('No update is ready to download.');
    await autoUpdater.downloadUpdate();
    return true;
  });

  ipcMain.handle('update:install', (event) => {
    validateSender(event);
    if (!app.isPackaged || updateState.status !== 'downloaded') throw new Error('Update download is not complete.');
    allowClientExit = true;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  });

  ipcMain.handle('app:choose-role', (event, payload) => {
    validateSender(event);
    if (runMode !== 'setup') throw new Error('Role is already configured.');
    const role = payload?.role;
    if (!['admin', 'client'].includes(role)) throw new Error('Choose server or client.');
    const deviceId = role === 'client' ? `device-${crypto.randomUUID()}` : null;
    fs.mkdirSync(cafeDataRoot, { recursive: true });
    fs.writeFileSync(roleFile, JSON.stringify({ role, deviceId }));
    app.relaunch({ args: [] });
    setImmediate(() => app.quit());
    return true;
  });

  ipcMain.handle('admin:login', (event, pin) => {
    validateSender(event);
    if (runMode !== 'admin') throw new Error('Cashier login is only available in the admin console.');
    const now = Date.now();
    if (now < adminBlockedUntil) return { ok: false, retryAfterSeconds: Math.ceil((adminBlockedUntil - now) / 1000) };
    if (!store.get().pinChanged || !verifyPin(pin, store.get().security)) {
      failedAdminLogins += 1;
      if (failedAdminLogins >= 5) { adminBlockedUntil = now + 30000; failedAdminLogins = 0; }
      return { ok: false, retryAfterSeconds: Math.ceil(Math.max(0, adminBlockedUntil - now) / 1000) };
    }
    failedAdminLogins = 0;
    adminAuthorized = true;
    broadcastState();
    return { ok: true };
  });

  ipcMain.handle('admin:logout', (event) => {
    validateSender(event);
    if (runMode !== 'admin') throw new Error('Cashier logout is only available in the admin console.');
    adminAuthorized = false;
    broadcastState();
    return true;
  });

  ipcMain.handle('admin:review-account', (event, id, approve) => {
    validateSender(event);
    if (runMode !== 'admin' || !adminAuthorized) throw new Error('Cashier login required.');
    accountDb.reviewAccount(Number(id), approve === true);
    broadcastState();
    return true;
  });

  ipcMain.handle('admin:review-topup', (event, id, approve) => {
    validateSender(event);
    if (runMode !== 'admin' || !adminAuthorized) throw new Error('Cashier login required.');
    accountDb.reviewTopup(Number(id), approve === true);
    broadcastState();
    return true;
  });

  ipcMain.handle('admin:rename-client', (event, payload) => {
    validateSender(event);
    if (runMode !== 'admin' || !adminAuthorized) throw new Error('Cashier login required.');
    const result = accountDb.renameWorkstation(payload?.deviceId, payload?.name);
    broadcastState();
    return result;
  });

  ipcMain.handle('client:setup', async (event, payload) => {
    validateSender(event);
    if (runMode !== 'client') throw new Error('Workstation setup only.');
    await clientApi.setup(payload?.ip);
    serverError = null;
    configureAutoStart(true);
    broadcastState();
    return true;
  });

  ipcMain.handle('client:quit-setup', (event) => {
    validateSender(event);
    if (runMode !== 'client' || clientApi?.config) throw new Error('Client setup is already complete.');
    app.quit();
    return true;
  });

  ipcMain.handle('client:register', async (event, payload) => {
    validateSender(event);
    if (runMode !== 'client') throw new Error('Workstation registration only.');
    return clientApi.register(payload?.username, payload?.password);
  });

  ipcMain.handle('client:login', async (event, payload) => {
    validateSender(event);
    if (runMode !== 'client') throw new Error('Workstation login only.');
    const profile = await clientApi.login(payload?.username, payload?.password);
    clientStatusAt = Date.now();
    serverError = null;
    broadcastState();
    return profile;
  });

  ipcMain.handle('client:logout', async (event) => {
    validateSender(event);
    if (runMode !== 'client') throw new Error('Workstation logout only.');
    try { await clientApi.logout(); }
    finally { clientStatusAt = 0; broadcastState(); }
    return true;
  });

  ipcMain.handle('client:topup', async (event, amountCents) => {
    validateSender(event);
    if (runMode !== 'client') throw new Error('Workstation top-up only.');
    const profile = await clientApi.topup(amountCents);
    clientStatusAt = Date.now();
    broadcastState();
    return profile;
  });

  ipcMain.handle('security:update-pin', (event, payload) => {
    validateSender(event);
    if (runMode !== 'admin') throw new Error('PIN changes are available from the admin console only.');
    if (store.get().pinChanged && !adminAuthorized) throw new Error('Cashier login required.');
    const { currentPin, nextPin } = payload || {};
    if (!verifyPin(currentPin, store.get().security)) throw new Error('Current PIN is incorrect.');
    if (!/^\d{6,12}$/.test(String(nextPin || '')) || nextPin === '2468') throw new Error('New PIN must contain 6 to 12 digits.');
    store.update((state) => addActivity({ ...state, security: hashPin(nextPin), pinChanged: true }, 'Administrator PIN changed'));
    adminAuthorized = true;
    broadcastState();
    return true;
  });

  ipcMain.handle('settings:launch-at-login', (event, enabled) => {
    validateSender(event);
    if (runMode !== 'admin' || !adminAuthorized) throw new Error('Cashier login required.');
    const active = configureAutoStart(Boolean(enabled));
    store.update((state) => ({ ...state, settings: { ...state.settings, launchAtLogin: active } }));
    broadcastState();
    return active;
  });
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  if (runMode === 'setup') {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    registerIpc();
    createWindow();
    initializeUpdater();
    return;
  }
  if (runMode === 'admin') {
    store = new JsonStore(path.join(cafeDataRoot, 'admin', 'cafetimer.json'));
    accountDb = new AccountDb(path.join(cafeDataRoot, 'admin', 'accounts.sqlite'));
    serverIdentity = await loadIdentity(cafeDataRoot);
    await startServer(serverIdentity, accountDb);
  } else {
    const clientConfigPath = path.join(app.getPath('userData'), 'client-server.json');
    const legacyConfigPath = savedRole?.stationId ? path.join(cafeDataRoot, savedRole.stationId, 'client-server.json') : null;
    if (legacyConfigPath && !fs.existsSync(clientConfigPath) && fs.existsSync(legacyConfigPath)) {
      fs.mkdirSync(path.dirname(clientConfigPath), { recursive: true });
      fs.copyFileSync(legacyConfigPath, clientConfigPath);
    }
    clientApi = new ClientApi(clientConfigPath, clientDeviceId);
  }
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  registerIpc();
  createWindow();
  initializeUpdater();
  if ((runMode === 'client' && clientApi.config) || (runMode === 'admin' && store.get().settings.launchAtLogin)) configureAutoStart(true);

  if (runMode === 'admin') store.update((state) => ({ ...state, heartbeatAt: Date.now() }));

  setInterval(async () => {
    if (runMode === 'client') {
      if (clientApi.config && !clientPollBusy) {
        clientPollBusy = true;
        try {
          await clientApi.presence();
          if (clientApi.token) { await clientApi.status(); clientStatusAt = Date.now(); }
          serverError = null;
        }
        catch (error) {
          clientApi.profile = null;
          clientApi.token = null;
          clientStatusAt = 0;
          serverError = error.message;
        }
        finally { clientPollBusy = false; }
      }
    } else {
      const before = store.get();
      const next = require('./session-core').normalizeExpiredStations(before);
      if (next !== before) store.set(addActivity(next, 'A workstation session expired'));
      store.update((state) => ({ ...state, heartbeatAt: Date.now() }));
    }
    broadcastState();
  }, 1000).unref();
}).catch((error) => {
  console.error('CafeTimer startup failed:', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (runMode !== 'client' || !clientApi?.config) app.quit();
});
