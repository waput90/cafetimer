const appElement = document.querySelector('#app');
const sessionDialog = document.querySelector('#session-dialog');
const pinDialog = document.querySelector('#pin-dialog');
const toastElement = document.querySelector('#toast');
const updateBanner = document.querySelector('#update-banner');
let bootstrap;
let state;
let toastTimer;
let clientAuthorized = false;
let adminAuthorized = false;
let lastClientViewKey = null;
let lastAdminViewKey = null;
let client = null;
let server = null;
let clientFormMode = 'login';
let clientSetupMode = false;
let updateState = null;

function money(cents) { return `PHP ${(Number(cents || 0) / 100).toFixed(2)}`; }
function shortDate(value) { return value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'; }
function durationBetween(start, end) { return formatTime(Math.floor(Math.max(0, end - start) / 1000)); }

function renderRoleSetup() {
  if (lastClientViewKey === 'role') return;
  lastClientViewKey = 'role';
  appElement.innerHTML = `<main class="client-lock"><section class="lock-card">
    <div class="lock-logo">C</div><p class="eyebrow">FIRST LAUNCH</p><h1>Choose this PC's role</h1>
    <p class="help">Use the same installer on the cashier PC and each workstation.</p>
    <form id="role-form" class="client-login-form">
      <label>Role <select name="role"><option value="admin">Server / cashier</option><option value="client">Client / workstation</option></select></label>
      <p class="error" role="alert"></p><button class="primary" type="submit">Continue</button>
    </form></section></main>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatTime(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined) return 'OPEN TIME';
  const safeSeconds = Math.max(0, totalSeconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function showToast(message) {
  toastElement.textContent = message;
  toastElement.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastElement.classList.remove('show'), 2400);
}

function renderUpdate() {
  if (!updateState || !['available', 'downloading', 'downloaded'].includes(updateState.status)) {
    updateBanner.hidden = true;
    return;
  }
  updateBanner.hidden = false;
  const action = document.querySelector('#update-action');
  const later = document.querySelector('#update-later');
  if (updateState.status === 'available') {
    document.querySelector('#update-title').textContent = `CafeTimer ${updateState.version} is available`;
    document.querySelector('#update-message').textContent = 'Download the new server and client version from GitHub Releases.';
    action.textContent = 'Download update';
    action.disabled = false;
    later.hidden = false;
  } else if (updateState.status === 'downloading') {
    document.querySelector('#update-title').textContent = 'Downloading CafeTimer update';
    document.querySelector('#update-message').textContent = `${updateState.percent || 0}% complete`;
    action.textContent = 'Downloading…';
    action.disabled = true;
    later.hidden = true;
  } else {
    document.querySelector('#update-title').textContent = `CafeTimer ${updateState.version} is ready`;
    document.querySelector('#update-message').textContent = 'Restart the app to finish installing the update.';
    action.textContent = 'Restart and install';
    action.disabled = false;
    later.hidden = false;
  }
}

function stationTimer(station) {
  if (station.status === 'available') return 'Ready';
  if (station.status === 'expired') return '00:00:00';
  return formatTime(station.remainingSeconds);
}

function stationActions(station) {
  if (station.status === 'available' || station.status === 'expired') {
    return `<button class="start" data-action="open-session" data-station="${station.id}">${station.status === 'expired' ? 'Restart' : 'Start session'}</button>`;
  }
  const pauseAction = station.status === 'paused' ? 'resume' : 'pause';
  const pauseLabel = station.status === 'paused' ? 'Resume' : 'Pause';
  const extend = station.openTime ? '' : `<button data-action="extend" data-station="${station.id}">+15m</button>`;
  return `${extend}<button data-action="${pauseAction}" data-station="${station.id}">${pauseLabel}</button><button class="danger" data-action="stop" data-station="${station.id}">End</button>`;
}

function renderAdmin() {
  if (!adminAuthorized) {
    const viewKey = String(state.pinChanged);
    if (viewKey === lastAdminViewKey) return;
    lastAdminViewKey = viewKey;
    appElement.innerHTML = `<main class="client-lock"><section class="lock-card">
      <div class="lock-logo">C</div><p class="eyebrow">CASHIER CONSOLE</p><h1>${state.pinChanged ? 'Cashier login' : 'Set administrator PIN'}</h1>
      <p class="help">${state.pinChanged ? 'Enter the administrator PIN to manage workstations.' : 'Change the initial PIN before the console can control workstations.'}</p>
      ${state.pinChanged ? '<form id="admin-login-form" class="client-login-form"><label for="cashier-pin">Administrator PIN</label><input id="cashier-pin" type="password" inputmode="numeric" maxlength="12" autocomplete="off" required><p id="admin-login-error" class="error" role="alert"></p><button class="primary" type="submit">Log in</button></form>' : '<button class="primary" data-action="change-pin">Change PIN</button>'}
    </section></main>`;
    return;
  }
  lastAdminViewKey = null;
  const stations = (state.connectedStations || []).map(({ deviceId, name }) => {
    const station = { id: deviceId, name: name || 'New client' };
    const current = (state.sessions || []).find((session) => session.deviceId === deviceId);
    return current ? { ...station, status: current.balanceMicrocents > 0 ? 'active' : 'expired',
      userId: current.userId, customer: current.username,
      remainingSeconds: Math.floor(current.balanceMicrocents * (state.pricing?.secondsPerPeso || 120) / 100_000_000) } :
      { ...station, status: 'available', customer: null };
  });
  const active = stations.filter((station) => station.status === 'active').length;
  const pendingAccounts = (state.accounts || []).filter((account) => account.status === 'pending').length;
  const available = stations.filter((station) => station.status === 'available').length;
  const today = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
  const now = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());

  appElement.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark">C</div><div><strong>${escapeHtml(state.cafeName)}</strong><small>CONTROL CENTER</small></div></div>
        <nav class="nav" aria-label="Main navigation">
          <button class="active"><span class="nav-icon">▦</span> Dashboard</button>
          <button><span class="nav-icon">◫</span> Workstations</button>
          <button><span class="nav-icon">◎</span> Members</button>
          <button><span class="nav-icon">▥</span> Reports</button>
          <button><span class="nav-icon">⚙</span> Settings</button>
        </nav>
        <div class="sidebar-footer"><div class="connection"><span class="pulse"></span> LAN server online</div><small>${stations.length} clients connected</small><button class="secondary" data-action="admin-logout">Log out</button></div>
      </aside>
      <main class="main">
        <header class="topbar"><div><p class="eyebrow">LIVE OPERATIONS</p><h1>Good day, Administrator</h1><p>Here’s what is happening across your cafe.</p></div><div class="clock"><strong>${now}</strong><small>${today}</small></div></header>
        <section class="stats" aria-label="Cafe statistics">
          <div class="stat"><span class="stat-label">Active sessions</span><strong class="stat-value green">${active}</strong></div>
          <div class="stat"><span class="stat-label">Available PCs</span><strong class="stat-value">${available}</strong></div>
          <div class="stat"><span class="stat-label">Pending accounts</span><strong class="stat-value yellow">${pendingAccounts}</strong></div>
          <div class="stat"><span class="stat-label">Sales today</span><strong class="stat-value">${money(state.sales?.todayCents)}</strong></div>
        </section>
        <section class="server-card"><strong>Server setup for workstations</strong><p>Enter this IP on each client: ${(server?.addresses || []).map(escapeHtml).join(', ') || 'No LAN address'} · Port: ${server?.port || ''}</p><p>The client remembers this server's certificate during its first successful connection.</p></section>
        <section class="admin-requests"><div><h2>Global timer pricing</h2>
          <form id="pricing-form" class="inline-form"><label>Minutes per PHP 1 <input name="minutesPerPeso" type="number" min="0.1667" max="1440" step="0.0167" value="${((state.pricing?.secondsPerPeso || 120) / 60).toFixed(2)}" required></label><button class="primary">Save rate</button></form>
          <p class="muted">Current equivalent: ${money(state.pricing?.rateCentsPerHour)} per hour.</p></div>
          <div><h2>Sales report</h2><p class="sales-total">${money(state.sales?.allTimeCents)}</p><p class="muted">All-time approved top-ups · Today ${money(state.sales?.todayCents)}</p></div></section>
        <section class="admin-requests"><div><h2>Account approvals</h2>
          ${(state.accounts || []).filter((account) => account.status === 'pending').map((account) => `<article class="request-row"><strong>${escapeHtml(account.username)}</strong><div><button data-action="approve-account" data-id="${account.id}">Approve</button><button data-action="reject-account" data-id="${account.id}">Reject</button></div></article>`).join('') || '<p class="muted">No pending accounts.</p>'}</div>
          <div><h2>Top-up requests</h2>${(state.topupRequests || []).map((request) => `<article class="request-row"><strong>${escapeHtml(request.username)} · ${money(request.amountCents)}</strong><div><button data-action="approve-topup" data-id="${request.id}">Approve</button><button data-action="reject-topup" data-id="${request.id}">Reject</button></div></article>`).join('') || '<p class="muted">No pending top-ups.</p>'}</div></section>
        <section class="server-card"><strong>Members</strong><div class="admin-table">${(state.accounts || []).map((account) => {
          const activeSession = (state.sessions || []).find((session) => session.userId === account.id);
          return `<article class="member-row"><div><b>${escapeHtml(account.username)}</b><small>${account.bannedAt ? 'Banned' : escapeHtml(account.status)} · ${money(Math.floor(account.balanceMicrocents / 1_000_000))}${activeSession ? ' · Online' : ''}</small></div><div class="row-actions">
            <button data-action="member-topup" data-id="${account.id}" data-name="${escapeHtml(account.username)}">Top up</button>
            <button data-action="edit-member" data-id="${account.id}" data-name="${escapeHtml(account.username)}">Edit</button>
            <button data-action="toggle-ban" data-id="${account.id}" data-banned="${account.bannedAt ? 'true' : 'false'}">${account.bannedAt ? 'Unban' : 'Ban'}</button>
            ${activeSession ? `<button class="danger" data-action="force-logout" data-device="${activeSession.deviceId}">Log out</button>` : ''}
          </div></article>`;
        }).join('') || '<p class="muted">No members yet.</p>'}</div></section>
        <div class="section-heading"><h2>Workstation floor</h2><div class="legend"><span class="available">Available</span><span class="active">In use</span><span class="paused">Paused</span></div></div>
        <section class="station-grid">
          ${stations.map((station) => `
            <article class="station ${station.status}">
              <div class="station-head"><div><h3 class="station-id">${escapeHtml(station.name)}</h3><div class="station-name">${escapeHtml(station.id)}</div></div><span class="status-dot"></span></div>
              <div class="timer">${stationTimer(station)}</div>
              <div class="customer">${escapeHtml(station.customer || (station.status === 'expired' ? 'Time expired' : 'No active customer'))}</div>
              <div class="customer">${station.status === 'active' ? 'Logged in' : 'Waiting for approved account'}</div>
              <div class="station-actions"><button class="secondary" data-action="rename-client" data-device="${station.id}" data-name="${escapeHtml(station.name)}">Rename</button>${station.customer ? `<button class="danger" data-action="force-logout" data-device="${station.id}">Log out</button>` : ''}</div>
            </article>`).join('') || '<p class="muted">No workstations connected. Configure a client with this server IP.</p>'}
        </section>
        <section class="report-grid"><div class="server-card"><strong>Recent sales</strong><div class="compact-list">${(state.sales?.recent || []).map((sale) => `<span><b>${money(sale.amountCents)}</b> ${escapeHtml(sale.username)}<small>${sale.source === 'admin' ? 'Cashier top-up' : 'Approved request'} · ${shortDate(sale.reviewedAt)}</small></span>`).join('') || '<p class="muted">No sales recorded.</p>'}</div></div>
          <div class="server-card"><strong>Client usage history</strong><div class="compact-list">${(state.usageHistory || []).map((item) => `<span><b>${escapeHtml(item.username)}</b> on ${escapeHtml(item.workstationName || item.deviceId)}<small>${durationBetween(item.startedAt, item.endedAt)} · ${money(Math.floor(item.chargedMicrocents / 1_000_000))} · ${escapeHtml(item.endReason.replaceAll('_', ' '))}</small></span>`).join('') || '<p class="muted">No completed sessions.</p>'}</div></div></section>
      </main>
      <aside class="activity-panel">
        <p class="eyebrow">SYSTEM LOG</p><h2>Recent activity</h2>
        <div class="activity-list">${(state.activity || []).map((item) => `<div class="activity-item"><p>${escapeHtml(item.text)}</p><time>${new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>`).join('')}</div>
        <div class="security-card"><strong>Protected client mode</strong><p>${state.pinChanged ? 'Administrator PIN configured.' : 'Change the initial PIN before client exit is enabled.'}</p><button class="secondary" data-action="change-pin">Change PIN</button> <button class="secondary" data-action="security-info">Deployment guide</button></div>
      </aside>
    </div>`;
}

function renderNetworkClient() {
  if (!client?.configured || clientSetupMode) {
    if (lastClientViewKey === 'setup') return;
    lastClientViewKey = 'setup';
    appElement.innerHTML = `<main class="client-lock"><section class="lock-card">
      <div class="lock-logo">C</div><p class="eyebrow">CLIENT SETUP</p>
      <h1>Connect to cashier server</h1><p class="help">Enter the server IPv4 address. Its certificate will be verified and remembered automatically.</p>
      <form id="server-setup-form" class="client-login-form">
        <label>Server IPv4 address <input name="ip" type="text" inputmode="decimal" placeholder="192.168.1.10" required></label>
        <p class="error" role="alert"></p><button class="primary" type="submit">Connect</button>
      </form>
      ${client?.configured ? '' : '<button class="admin-link" data-action="close-setup">Close app</button>'}
    </section></main>`;
    return;
  }
  const profile = client.online ? client.profile : null;
  if (profile) {
    const viewKey = `account:${client.name}:${profile.username}:${profile.balanceCents}:${profile.secondsRemaining}:${JSON.stringify(profile.topups)}`;
    if (viewKey === lastClientViewKey) return;
    lastClientViewKey = viewKey;
    const details = `<span>${escapeHtml(profile.username)} · ${money(profile.balanceCents)}</span>`;
    if (profile.accessAllowed) {
      appElement.innerHTML = `<main class="client-hud"><div class="hud-mark">C</div>
        <div class="hud-body"><div class="hud-meta">${details}</div><div class="hud-time">${formatTime(profile.secondsRemaining)}</div></div>
        <button class="hud-admin" data-action="topup">Top up</button><button class="hud-admin" data-action="logout">Log out</button>
      </main>`;
    } else {
      appElement.innerHTML = `<main class="client-lock"><section class="lock-card">
        <div class="lock-logo">C</div><p class="eyebrow">${escapeHtml(client.name || 'CafeTimer client')}</p><h1>No time remaining</h1>
        <p class="help">${details}<br>Time: ${formatTime(profile.secondsRemaining)}</p>
        <button class="primary" data-action="topup">Request top-up</button>
        <button class="secondary" data-action="logout">Log out</button>
        <div class="client-message">${(profile.topups || []).slice(0, 3).map((item) => `${money(item.amountCents)}: ${escapeHtml(item.status)}`).join(' · ') || 'Ask the cashier to approve a top-up.'}</div>
      </section></main>`;
    }
    return;
  }
  const viewKey = `auth:${client.name}:${clientFormMode}:${client.error || ''}`;
  if (viewKey === lastClientViewKey) return;
  lastClientViewKey = viewKey;
  const registering = clientFormMode === 'register';
  appElement.innerHTML = `<main class="client-lock"><section class="lock-card">
    <div class="lock-logo">C</div><p class="eyebrow">${escapeHtml(client.name || 'CafeTimer client')} · ${escapeHtml(client.ip)}</p>
    <h1>${registering ? 'Create account' : 'Customer login'}</h1>
    <p class="help">${registering ? 'A cashier must approve your account before you can log in.' : 'Log in with an approved account. The workstation unlocks when you have time balance.'}</p>
    ${client.error ? `<p class="error">${escapeHtml(client.error)}</p>` : ''}
    <form id="${registering ? 'client-register-form' : 'client-login-form'}" class="client-login-form">
      <label>Username <input name="username" type="text" minlength="3" maxlength="24" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" minlength="12" maxlength="128" autocomplete="${registering ? 'new-password' : 'current-password'}" required></label>
      ${registering ? '<label>Confirm password <input name="confirm" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label>' : ''}
      <p class="error" role="alert"></p><button class="primary" type="submit">${registering ? 'Request account' : 'Log in'}</button>
    </form>
    <button class="admin-link" data-action="toggle-register">${registering ? 'Back to login' : 'Create an account'}</button>
    <button class="admin-link" data-action="change-server">Change server</button>
  </section></main>`;
}

function renderClient() {
  const station = state.stations.find((item) => item.id === bootstrap.stationId);
  const stateFresh = Date.now() - state.heartbeatAt < 5000;
  if (!station || station.status !== 'active' || !clientAuthorized || !stateFresh) {
    const viewKey = `${station?.status || 'missing'}:${station?.message || ''}:${stateFresh}`;
    if (viewKey === lastClientViewKey) return;
    lastClientViewKey = viewKey;
    const canLogin = station?.status === 'active' && stateFresh;
    const status = !stateFresh ? 'CASHIER OFFLINE' : station?.status === 'paused' ? 'PAUSED'
      : station?.status === 'expired' ? 'TIME EXPIRED' : canLogin ? 'LOGIN REQUIRED' : 'WAITING FOR SESSION';
    appElement.innerHTML = `<main class="client-lock"><section class="lock-card">
      <div class="lock-logo">C</div><p class="eyebrow">${escapeHtml(state.cafeName)}</p>
      <h1>${status === 'TIME EXPIRED' ? 'Session ended' : status === 'PAUSED' ? 'Session paused' : 'Workstation locked'}</h1>
      <p class="station-label">${escapeHtml(bootstrap.stationId)}</p><div class="lock-status">${status}</div>
      ${canLogin ? '<form id="client-login-form" class="client-login-form"><label for="client-code">Session access code</label><input id="client-code" type="password" maxlength="64" autocomplete="off" required><p id="client-login-error" class="error" role="alert"></p><button class="primary" type="submit">Log in</button></form>' : ''}
      ${station?.message ? `<div class="client-message">${escapeHtml(station.message)}</div>` : ''}
      <p class="help">A cashier session and customer login are required before use.</p>
      <button class="admin-link" data-action="unlock">Administrator access</button>
    </section></main>`;
    return;
  }
  lastClientViewKey = null;
  if (!station || station.status === 'available' || station.status === 'expired') {
    appElement.innerHTML = `
      <main class="client-lock">
        <section class="lock-card">
          <div class="lock-logo">C</div>
          <p class="eyebrow">${escapeHtml(state.cafeName)}</p>
          <h1>${station?.status === 'expired' ? 'Session ended' : 'Workstation locked'}</h1>
          <p class="station-label">${escapeHtml(bootstrap.stationId)} · Ask the cashier to begin a session</p>
          <div class="lock-status">● ${station?.status === 'expired' ? 'TIME EXPIRED' : 'WAITING FOR SESSION'}</div>
          ${station?.message ? `<div class="client-message">${escapeHtml(station.message)}</div>` : ''}
          <p class="help">This computer is managed by CafeTimer. A valid session from the cashier desk is required before use.</p>
          <button class="admin-link" data-action="unlock">Administrator access</button>
        </section>
      </main>`;
    return;
  }
  appElement.innerHTML = `
    <main class="client-hud">
      <div class="hud-mark">C</div>
      <div class="hud-body"><div class="hud-meta"><span>${escapeHtml(bootstrap.stationId)} · ${escapeHtml(station.customer)}</span><span>${station.status.toUpperCase()}</span></div><div class="hud-time ${station.status}">${stationTimer(station)}</div></div>
      <button class="hud-admin" data-action="unlock" aria-label="Administrator access">⋮</button>
    </main>`;
  appElement.querySelector('.client-hud').insertAdjacentHTML('beforeend', '<button class="hud-admin" data-action="logout">Lock</button>');
}

function render() {
  if (!bootstrap || !state) return;
  if (bootstrap.mode === 'setup') renderRoleSetup();
  else if (bootstrap.mode === 'client') renderNetworkClient();
  else renderAdmin();
}

async function runStationAction(action) {
  try {
    const result = await window.cafeTimer.stationAction(action);
    state = result.state;
    render();
    if (result.accessCode) {
      document.querySelector('#access-title').textContent = `${action.stationId} access code`;
      document.querySelector('#access-code').textContent = result.accessCode;
      document.querySelector('#access-dialog').showModal();
    } else showToast('Workstation updated');
  } catch (error) {
    showToast(error.message || 'Unable to update workstation');
  }
}

function openSessionDialog(stationId) {
  document.querySelector('#session-station-id').value = stationId;
  document.querySelector('#session-title').textContent = `Start ${stationId}`;
  document.querySelector('#customer-name').value = '';
  document.querySelector('#open-time').checked = false;
  sessionDialog.showModal();
  document.querySelector('#customer-name').focus();
  updatePrice();
}

function updatePrice() {
  const minutes = Number(document.querySelector('#session-minutes').value);
  const openTime = document.querySelector('#open-time').checked;
  document.querySelector('#duration-output').textContent = openTime ? 'Open time' : `${minutes} min`;
  document.querySelector('#price-output').textContent = openTime ? `₱${Number(state?.hourlyRate || 0).toFixed(2)}/hr` : `₱${((minutes / 60) * state.hourlyRate).toFixed(2)}`;
}

appElement.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const stationId = button.dataset.station;
  if (action === 'open-session') openSessionDialog(stationId);
  if (action === 'extend') runStationAction({ type: 'extend', stationId, minutes: 15 });
  if (action === 'pause' || action === 'resume' || action === 'stop') runStationAction({ type: action, stationId });
  if (action === 'unlock') {
    document.querySelector('#admin-pin').value = '';
    document.querySelector('#pin-error').textContent = '';
    pinDialog.showModal();
    document.querySelector('#admin-pin').focus();
  }
  if (action === 'security-info') showToast('See README.md for Windows kiosk deployment.');
  if (action === 'change-pin') {
    document.querySelector('#change-pin-form').reset();
    document.querySelector('#change-pin-error').textContent = '';
    document.querySelector('#change-pin-dialog').showModal();
  }
  if (action === 'logout') window.cafeTimer.clientLogout();
  if (action === 'admin-logout') window.cafeTimer.adminLogout();
  if (action === 'toggle-register') { clientFormMode = clientFormMode === 'login' ? 'register' : 'login'; lastClientViewKey = null; render(); }
  if (action === 'change-server') { clientSetupMode = true; lastClientViewKey = null; render(); }
  if (action === 'close-setup') window.cafeTimer.quitClientSetup();
  if (action === 'rename-client') {
    document.querySelector('#rename-device-id').value = button.dataset.device;
    document.querySelector('#rename-client-name').value = button.dataset.name;
    document.querySelector('#rename-client-error').textContent = '';
    document.querySelector('#rename-client-dialog').showModal();
    document.querySelector('#rename-client-name').focus();
  }
  if (action === 'member-topup') {
    document.querySelector('#member-topup-form').reset();
    document.querySelector('#member-topup-id').value = button.dataset.id;
    document.querySelector('#member-topup-title').textContent = `Add balance to ${button.dataset.name}`;
    document.querySelector('#member-topup-error').textContent = '';
    document.querySelector('#member-topup-dialog').showModal();
    document.querySelector('#member-topup-amount').focus();
  }
  if (action === 'edit-member') {
    document.querySelector('#edit-member-form').reset();
    document.querySelector('#edit-member-id').value = button.dataset.id;
    document.querySelector('#edit-member-username').value = button.dataset.name;
    document.querySelector('#edit-member-error').textContent = '';
    document.querySelector('#edit-member-dialog').showModal();
    document.querySelector('#edit-member-username').focus();
  }
  if (action === 'toggle-ban') window.cafeTimer.setMemberBanned(Number(button.dataset.id), button.dataset.banned !== 'true')
    .then(() => showToast(button.dataset.banned === 'true' ? 'Member unbanned' : 'Member banned'))
    .catch((error) => showToast(error.message));
  if (action === 'force-logout') window.cafeTimer.forceLogout(button.dataset.device)
    .then(() => showToast('Client logged out'))
    .catch((error) => showToast(error.message));
  if (action === 'topup') { document.querySelector('#topup-form').reset(); document.querySelector('#topup-error').textContent = ''; document.querySelector('#topup-dialog').showModal(); }
  if (action === 'approve-account' || action === 'reject-account') window.cafeTimer.reviewAccount(Number(button.dataset.id), action === 'approve-account').catch((error) => showToast(error.message));
  if (action === 'approve-topup' || action === 'reject-topup') window.cafeTimer.reviewTopup(Number(button.dataset.id), action === 'approve-topup').catch((error) => showToast(error.message));
});

appElement.addEventListener('submit', async (event) => {
  if (event.target.id === 'role-form') {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    try { await window.cafeTimer.chooseRole(data.get('role')); }
    catch (error) { form.querySelector('.error').textContent = error.message || 'Unable to save role.'; }
    return;
  }
  if (!['server-setup-form', 'client-register-form', 'client-login-form'].includes(event.target.id)) return;
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const errorElement = form.querySelector('.error');
  errorElement.textContent = '';
  try {
    if (form.id === 'server-setup-form') {
      await window.cafeTimer.clientSetup(data.get('ip'));
      clientSetupMode = false; lastClientViewKey = null; render();
    }
    else if (form.id === 'client-register-form') {
      if (data.get('password') !== data.get('confirm')) throw new Error('Passwords do not match.');
      await window.cafeTimer.clientRegister(data.get('username'), data.get('password'));
      clientFormMode = 'login'; lastClientViewKey = null; render();
      showToast('Account request sent. Wait for cashier approval.');
    } else await window.cafeTimer.clientLogin(data.get('username'), data.get('password'));
    form.reset();
  } catch (error) {
    errorElement.textContent = error.message || 'Request failed.';
  }
});

appElement.addEventListener('submit', async (event) => {
  if (event.target.id !== 'admin-login-form') return;
  event.preventDefault();
  const input = document.querySelector('#cashier-pin');
  const pin = input.value;
  input.value = '';
  try {
    const result = await window.cafeTimer.adminLogin(pin);
    if (!result.ok) document.querySelector('#admin-login-error').textContent = result.retryAfterSeconds
      ? `Try again in ${result.retryAfterSeconds} seconds.` : 'Incorrect administrator PIN.';
  } catch {
    document.querySelector('#admin-login-error').textContent = 'Login unavailable.';
  }
});

document.querySelector('#session-minutes').addEventListener('input', updatePrice);
document.querySelector('#open-time').addEventListener('change', updatePrice);
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => {
  document.querySelector(`#${button.dataset.closeDialog}`).close();
}));
document.querySelectorAll('[data-minutes]').forEach((button) => button.addEventListener('click', () => {
  document.querySelector('#session-minutes').value = button.dataset.minutes;
  document.querySelector('#open-time').checked = false;
  updatePrice();
}));

document.querySelector('#session-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runStationAction({
    type: 'start',
    stationId: document.querySelector('#session-station-id').value,
    customer: document.querySelector('#customer-name').value,
    minutes: Number(document.querySelector('#session-minutes').value),
    openTime: document.querySelector('#open-time').checked
  });
  sessionDialog.close();
});

document.querySelector('#topup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const amountCents = Math.round(Number(document.querySelector('#topup-amount').value) * 100);
  try {
    await window.cafeTimer.clientTopup(amountCents);
    document.querySelector('#topup-dialog').close();
    showToast('Top-up request sent to cashier.');
  } catch (error) { document.querySelector('#topup-error').textContent = error.message || 'Request failed.'; }
});

document.querySelector('#rename-client-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await window.cafeTimer.renameClient(document.querySelector('#rename-device-id').value, document.querySelector('#rename-client-name').value);
    document.querySelector('#rename-client-dialog').close();
    showToast('Client renamed');
  } catch (error) { document.querySelector('#rename-client-error').textContent = error.message || 'Unable to rename client.'; }
});

appElement.addEventListener('submit', async (event) => {
  if (event.target.id !== 'pricing-form') return;
  event.preventDefault();
  const minutes = Number(new FormData(event.target).get('minutesPerPeso'));
  try {
    await window.cafeTimer.setPricing(Math.round(minutes * 60));
    showToast('Global timer rate updated');
  } catch (error) { showToast(error.message || 'Unable to update pricing.'); }
});

document.querySelector('#member-topup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const amountCents = Math.round(Number(document.querySelector('#member-topup-amount').value) * 100);
    await window.cafeTimer.directTopup(Number(document.querySelector('#member-topup-id').value), amountCents);
    document.querySelector('#member-topup-dialog').close();
    showToast('Balance added');
  } catch (error) { document.querySelector('#member-topup-error').textContent = error.message || 'Unable to add balance.'; }
});

document.querySelector('#edit-member-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await window.cafeTimer.updateMember(Number(document.querySelector('#edit-member-id').value),
      document.querySelector('#edit-member-username').value, document.querySelector('#edit-member-password').value);
    document.querySelector('#edit-member-dialog').close();
    showToast('Member updated');
  } catch (error) { document.querySelector('#edit-member-error').textContent = error.message || 'Unable to update member.'; }
});

document.querySelector('#change-pin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await window.cafeTimer.updatePin(document.querySelector('#current-pin').value, document.querySelector('#next-pin').value);
    document.querySelector('#change-pin-dialog').close();
    document.querySelector('#change-pin-form').reset();
    showToast('Administrator PIN changed');
  } catch (error) {
    document.querySelector('#change-pin-error').textContent = error.message || 'Unable to change PIN.';
  }
});

async function initialize() {
  try {
    bootstrap = await window.cafeTimer.bootstrap();
    state = bootstrap.state;
    clientAuthorized = bootstrap.clientAuthorized;
    adminAuthorized = bootstrap.adminAuthorized;
    client = bootstrap.client;
    server = bootstrap.server;
    updateState = bootstrap.update;
    render();
    renderUpdate();
    window.cafeTimer.onState((next) => {
      state = next.state;
      clientAuthorized = next.clientAuthorized;
      adminAuthorized = next.adminAuthorized;
      client = next.client;
      server = next.server;
      render();
    });
    window.cafeTimer.onUpdate((next) => { updateState = next; renderUpdate(); });
  } catch (error) {
    appElement.innerHTML = `<main class="client-lock"><section class="lock-card"><h1>Unable to start</h1><p class="muted">${escapeHtml(error.message)}</p></section></main>`;
  }
}

document.querySelector('#update-later').addEventListener('click', () => { updateBanner.hidden = true; });
document.querySelector('#update-action').addEventListener('click', async () => {
  try {
    if (updateState?.status === 'downloaded') await window.cafeTimer.installUpdate();
    else await window.cafeTimer.downloadUpdate();
  } catch (error) { showToast(error.message || 'Unable to update CafeTimer.'); }
});

initialize();
