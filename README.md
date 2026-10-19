# CafeTimer

CafeTimer uses one Windows installer for both roles. On first launch, choose **Server / cashier** or **Client / workstation**. Clients receive a persistent device ID automatically, and the cashier can rename each connected client. The cashier process hosts an HTTPS API and stores customer accounts, approvals, balances, top-up requests, workstation names, and login sessions in SQLite. Each workstation needs only the server IPv4 address before registration or login is available.

## Run

On the cashier PC:

```powershell
npm.cmd install
npm.cmd start
```

In the packaged app, choose **Server / cashier** on first launch. Change the initial administrator PIN (`2468`) to a private 6 to 12 digit PIN. The cashier console then shows the physical LAN IP address and fixed port `46321`; virtual Hyper-V, VPN, and VM adapter addresses are hidden when a physical adapter is available. Keep the cashier Windows account private. Allow inbound TCP port `46321` on the cashier PC's LAN firewall only for the workstation network.

On each workstation PC, install the same package and choose **Client / workstation** on first launch. The app creates its device ID automatically. For development, a fixed test device ID can be supplied with:

```powershell
npm.cmd run start:client
```

The first screen asks only for the cashier server IPv4 address. On the first successful connection, the client records that server certificate's SHA-256 fingerprint. Later connections must match the recorded fingerprint, so replacing the server certificate requires reconnecting the client. Before the first connection succeeds, the client stays in setup mode and can be closed with **Close app** or Alt+F4. After setup succeeds, managed client mode prevents ordinary app closing.

## Customer flow

1. The client offers **Create account** or **Log in** after server setup. A username has 3 to 24 letters, digits, or underscores; passwords have 12 to 128 characters.
2. New accounts are pending. The cashier approves or rejects each account in **Account approvals**. Passwords are salted scrypt hashes in the server database and are never shown to the cashier.
3. An approved customer can log in. If their balance is zero, the client stays on its lock screen and shows a **Request top-up** button. The cashier approves or rejects the request. Approval adds balance once.
4. Positive balance unlocks the desktop and shows the remaining time and balance in the always-on-top client timer. The cashier configures one global number of minutes per PHP 1. The server charges time from the account balance; a successful top-up extends the remaining time.
5. Logging out, using all balance, losing the server connection, or restarting the client returns to the lock screen. One account can have one active workstation session at a time. Billing advances only on an authenticated client heartbeat. If the app closes, the PC loses power, or the network disconnects without a proper logout, billing stops at the last confirmed heartbeat and the stale session is closed after five seconds.

The cashier dashboard shows only clients that successfully contact the server and have sent a heartbeat within the last five seconds, including clients at the login screen. The cashier can rename a connected client; that name remains in the server database. A disconnected PC disappears from the workstation list.

From the server dashboard, an authorized cashier can:

- Configure the global time per PHP 1. Active sessions are charged at the old rate up to the change and at the new rate afterward.
- View today's and all-time approved top-up sales, plus a recent sales list.
- Add balance directly to a member or approve a client top-up request.
- Log out an active client and review completed CafeTimer usage sessions with member, workstation, duration, charge, and logout reason.
- View members, change usernames, set a new password, and ban or unban accounts. Changing a password or banning an account closes its active session immediately.

The server console separates daily operations into Dashboard, Workstations, Members, Reports, and Settings. Each view keeps its own scroll position during live refreshes. Global timer pricing is under Settings, member approval and account controls are under Members, and Reports contains seven-day sales and all-time workstation usage charts alongside detailed sales and session history.

Passwords are never displayed. Usage history contains CafeTimer session records only; it does not capture screens, applications, files, or keystrokes. No payment processor is connected: an approved top-up records a cashier-confirmed credit, not an automatic payment.

## Storage and security

- Server database: `%APPDATA%\CafeTimer\admin\accounts.sqlite` on the cashier PC. SQLite creates its usual journal files beside it.
- Server TLS identity: `%APPDATA%\CafeTimer\admin\server-identity.json`. Back it up securely with the database; losing it changes the pinned identity and forces clients to be reconfigured.
- Cashier settings and PIN hash: `%APPDATA%\CafeTimer\admin\cafetimer.json`.
- Workstation setup: `%APPDATA%\CafeTimer\client\client-server.json`. It contains the server IP and automatically recorded certificate fingerprint, not the customer's password or session token.
- Installed role and generated device ID: `%APPDATA%\CafeTimer\install-role.json`. A command-line `--client=device-development-01` overrides it for development.

Credentials and session tokens travel through the Electron main process over HTTPS, with the server certificate pinned by its SHA-256 fingerprint. The first IP connection uses trust on first use, so perform initial setup on a trusted local network. The explicit pin allows the app to verify its self-signed server certificate without treating it as a root CA. The renderer has no Node access. The server keeps account approvals, top-up decisions, and balance updates authoritative. The client locks when status polling fails. The cashier PIN stays on the cashier PC; workstation exit requires Windows administrator recovery rather than sending that PIN over the network.

## GitHub Releases and updates

Packaged server and client installations check for a newer release shortly after launch and every six hours. A visible prompt offers to download the update, shows progress, and then offers **Restart and install**. The downloaded NSIS update runs without the installer wizard and keeps the original installation directory. Because CafeTimer is installed per-machine, Windows can still show a UAC credential prompt during an update.

The same per-machine installation requires a Windows administrator credential to uninstall CafeTimer through Apps & Features. This applies to both roles because they share one installer. CafeTimer does not use its in-app PIN as an uninstall password: Windows launches the uninstaller outside the Electron app, and Windows administrators retain control of installed software. Moving an older per-user installation to this release requires one manually approved, elevated installation.

Push a version tag such as `v1.2.0` to the GitHub repository. The tag must exactly equal `v` followed by the version in `package.json`; `v.1.2.0` is invalid. The workflow in `.github/workflows/release.yml` validates the tag, runs the tests, builds the NSIS installer, and publishes the installer, block map, and `latest.yml` through a draft-first GitHub release flow. Increase the `version` in `package.json` before creating the tag. The repository must be public for clients to update without storing a GitHub token on each PC.

An Electron overlay cannot guarantee that a customer cannot reach Windows controls. Deploy clients under a dedicated Windows standard user account with OS-enforced app allowlisting or a supported custom shell. Test keyboard shortcuts, Task Manager, sign-out, multi-monitor behavior, and recovery on a spare device. Windows Assigned Access and Shell Launcher have different capabilities and cannot be configured together. See Microsoft's [kiosk options](https://learn.microsoft.com/windows/configuration/kiosk/), [Assigned Access recommendations](https://learn.microsoft.com/windows/configuration/assigned-access/recommendations), and [Shell Launcher documentation](https://learn.microsoft.com/windows/configuration/shell-launcher/).

## Test and build

CafeTimer uses Electron Vite and TypeScript for the main process, preload, renderer, and tests. Tailwind CSS 4 is compiled through its Vite plugin and supplies the shared glass interface utilities.

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Windows kiosk policy, UAC prompts, silent update behavior, and live multi-PC deployment still require device testing.
