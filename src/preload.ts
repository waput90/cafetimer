// @ts-nocheck
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cafeTimer', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  chooseRole: (role) => ipcRenderer.invoke('app:choose-role', { role }),
  adminLogin: (pin) => ipcRenderer.invoke('admin:login', pin),
  adminLogout: () => ipcRenderer.invoke('admin:logout'),
  clientSetup: (ip) => ipcRenderer.invoke('client:setup', { ip }),
  quitClientSetup: () => ipcRenderer.invoke('client:quit-setup'),
  clientRegister: (username, password) => ipcRenderer.invoke('client:register', { username, password }),
  clientLogin: (username, password) => ipcRenderer.invoke('client:login', { username, password }),
  clientLogout: () => ipcRenderer.invoke('client:logout'),
  clientTopup: (amountCents) => ipcRenderer.invoke('client:topup', amountCents),
  reviewAccount: (id, approve) => ipcRenderer.invoke('admin:review-account', id, approve),
  reviewTopup: (id, approve) => ipcRenderer.invoke('admin:review-topup', id, approve),
  renameClient: (deviceId, name) => ipcRenderer.invoke('admin:rename-client', { deviceId, name }),
  setPricing: (secondsPerPeso) => ipcRenderer.invoke('admin:set-pricing', secondsPerPeso),
  directTopup: (userId, amountCents) => ipcRenderer.invoke('admin:direct-topup', { userId, amountCents }),
  updateMember: (userId, username, password) => ipcRenderer.invoke('admin:update-member', { userId, username, password }),
  setMemberBanned: (userId, banned) => ipcRenderer.invoke('admin:set-member-banned', { userId, banned }),
  forceLogout: (deviceId) => ipcRenderer.invoke('admin:force-logout', deviceId),
  updatePin: (currentPin, nextPin) => ipcRenderer.invoke('security:update-pin', { currentPin, nextPin }),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('settings:launch-at-login', Boolean(enabled)),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onState: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('state:changed', handler);
    return () => ipcRenderer.removeListener('state:changed', handler);
  },
  onUpdate: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('update:changed', handler);
    return () => ipcRenderer.removeListener('update:changed', handler);
  }
});
