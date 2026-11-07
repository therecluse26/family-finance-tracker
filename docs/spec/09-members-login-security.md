# Members, login, and security

Every Member has the same powers. Every Member signs in with a password plus TOTP; a passkey is an optional extra, over HTTPS only. `APP_URL` sets the security mode: HTTPS through a trusted proxy, or plain HTTP on a local address. The Master key encrypts the secrets that unlock outside services. Without it, a copy of the database gives no access to any bank.

## Members

- A Member is a person in the Household with a login. All Members see all data and have the same powers. There are no roles and no private Accounts.
- Each Member has a name, an email address, a password, and TOTP. No two Members share an email address.
- The first Member is made in the first-run wizard ([Install and first-run setup](12-install-and-first-run.md#the-first-run-wizard)). Every other Member joins by invite link.
- Each Member may change their own password, TOTP, and backup codes in settings.
- Any Member may remove any Member, themselves included. The app refuses to remove the last Member.
  - Removal ends that Member's sessions. It deletes their passkeys and removes their devices from web push.
  - The removed Member's Goals and Chat messages keep their name.

## Invites

- Any Member can make an invite link in settings. The wizard's Finish step and the "Finish setup" list link there.
- The app shows the link for the Member to copy and send. The app does not email it.
- Each invite link works once and expires after 7 days.
- Settings list the open invite links, each with a Cancel button.
- The token sits after `#`, as in `https://money.example.com/join#token=…`. The browser never sends it in the request line, so it stays out of proxy and access logs.
- The new Member sets a name, an email address, a password, and TOTP, and gets backup codes.
- A Member who joins by invite never sees the first-run wizard.

## Signing in

- Every Member has a password plus TOTP. There is no password-only login.
- Passwords have at least 12 characters, with no other composition rules. The app stores only a hash.
- TOTP codes have 6 digits and change every 30 seconds (RFC 6238).
- Each Member gets 10 one-use backup codes. A backup code works in place of a TOTP code.
- **Passkeys:**
  - A passkey is an optional extra. A Member adds one in settings, over HTTPS only.
  - A Member may add several passkeys and delete any of them.
  - A passkey alone signs a Member in, with no TOTP code.
  - In plain-HTTP mode, passkey setup and passkey sign-in are hidden. A note explains why.
- **Sessions:**
  - A session lasts 30 days and renews each time the Member uses the app.
  - Session cookies are `HttpOnly` and `SameSite=Lax`. In HTTPS mode they are also `Secure`.
  - Changing one's own password or TOTP, or getting new backup codes, ends that Member's other sessions and their sign-ins that wait for a code, at once. The session that made the change stays.
- **Signed-in devices:** Settings, My login lists the signed-in Member's own sessions that have not expired. This device comes first, then the others, newest first. Each row shows:
  - A short browser and system name, such as "Firefox on Linux" or "Safari on iPhone". The app reads it from the user agent that the browser sent at sign-in. It knows the common browsers (Chrome, Edge, Firefox, Safari, Opera, Samsung Internet) and systems (Windows, macOS, Linux, ChromeOS, Android, iPhone, iPad). A part it cannot tell is left out: "Firefox", or "Unknown browser on Linux". When it can tell neither part, the row says "Unknown browser".
  - When that device signed in, in the Household time zone, such as "Signed in Nov 6, 9:30 AM".
  - "this device" on the session that shows the page.
  - The page gets only these. It never gets the IP address, the user agent, the session token, or another Member's sessions.
- **Sign out on a device:**
  - "Sign out" on another device's row ends that one session at once. That device gets no more data and must sign in again.
  - "Sign out" on this device's row signs this device out, as the "Sign out" button does. That also clears the session cookie. A request to end this device's own session by its ID gets 409, "Sign this device out with Sign out.", and ends nothing.
  - "Sign out everywhere else" ends every other session of the Member, and their sign-ins that wait for a code, at once. This device stays signed in.
  - Neither asks for a code or the password ([Sensitive actions](#signing-in)).
  - A Member can end only their own sessions. When the session is not one of the Member's own open sessions, the app changes nothing and says "That device is already signed out." It gives the same answer for another Member's session, an expired session, an ended session, and an ID that no session has, so the answer does not show that a session exists.
  - Without a session, the request gets 401 and the sign-in page. A request from another site, or with no `Origin`, gets 403. A body that is not JSON gets 415. Each changes nothing.
  - **Risk:** a stolen session can sign out every other device of the Member, including the one the Member uses. It cannot take over the login or change any login part: a password change, a new passkey, a new TOTP, and new backup codes each ask for the current password ([Sensitive actions](#signing-in)). But it can keep the Member from signing in for a while. It signs out the Member's devices, then uses up the Member's failed sign-ins with wrong current passwords ([Failed sign-ins](#signing-in)), and it can do that again every 15 minutes. Then another Member resets the Member's login ([Login reset](#login-reset)), or, in a Household with one Member, the self-hoster runs `fft reset-login`. A reset ends every session of the Member, the thief's included.
- **Failed sign-ins:** the app allows 5 failed sign-ins per 15 minutes, per Member and per IP address. The app refuses further tries in that window without checking them. An IPv6 address counts with every address in its /64 network.
- **Sensitive actions:** the app asks for TOTP, a backup code, or a passkey only at sign-in. No action after sign-in asks for a code again. This includes a data export, an invite link, removing a Connection, resetting or removing a Member, signing out a device, and changing the Plaid keys, an AI key, or the SMTP settings.
  - A code again after sign-in added work for each Member and gave no real protection to a self-hosted app.
  - Changing one's own password asks for the current password. Adding a passkey, getting a new TOTP, and getting new backup codes ask for it too. Then a stolen session cannot take over the login, and cannot lock the Member out by replacing their TOTP or backup codes. A wrong current password counts as a failed sign-in. When a Member adds a passkey, a passkey that does not check the Member (by a PIN or a fingerprint) also counts as a failed sign-in. Other refusals, such as a name that is too long or plain-HTTP mode, do not count.
  - Getting a new TOTP also asks for one code from the new authenticator app, after the current password. That code proves the new setup. Getting new backup codes asks for nothing more than the current password.
  - The first-run wizard and an invite link set a Member's first TOTP, and a reset link sets a new one. They ask for no current password: the Member sets the password in the same step, and the setup code or the link's token proves the right to it.

## Login reset

- Any Member can reset another Member's login.
- A reset gives the resetting Member a one-use reset link that lasts 24 hours. They hand it to the other Member.
- The reset link lets that Member set a new password and new TOTP. It gives them new backup codes.
- Making a reset ends that Member's sessions at once. Their old password, TOTP, backup codes, and passkeys stop working at once.
- The token sits after `#`, as in invite links.
- **`fft reset-login <email>`** is the last resort when no Member can sign in. It prints a reset link for the Member with that email, under the same rules ([Install and first-run setup](12-install-and-first-run.md#the-fft-command)).
- The app never writes a setup code, invite token, or reset token to its log.

## Security mode

`APP_URL` sets the security mode. The client's network address never decides it, because Docker Desktop and rootless Docker rewrite that address. Then every request looks local. [ADR 0008](../adr/0008-app-url-sets-security-mode.md) records why.

| `APP_URL` starts with | The app accepts | Features |
|---|---|---|
| `https://` | Only requests from a trusted proxy that marks them as HTTPS (`X-Forwarded-Proto: https`), whose `Host` matches the host and port of `APP_URL`. It refuses every other request. This fails closed. | Every feature. |
| `http://` | Only requests whose `Host` matches the host and port of `APP_URL`. The `APP_URL` host must be local (below). | Password plus TOTP. Alerts go by email only. Passkeys, the install prompt, and web push are hidden, with a note that explains why. |

- **Local hosts.** In plain-HTTP mode, the `APP_URL` host must be one of these:
  - an address in `127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`, `fe80::/10`, or Tailscale's `100.64.0.0/10`;
  - the name `localhost`;
  - a name that ends in `.local`, `.lan`, `.home.arpa`, or `.internal`.
- At start, the app logs the reason and exits in each of these cases:
  - `APP_URL` is missing;
  - `APP_URL` has a scheme other than `https://` or `http://`;
  - `APP_URL` is `http://` and its host is not local.
- In both modes, a request with any other `Host` gets a page that names the `APP_URL` address, with status 421. That page holds no sign-in form. So a Member who enters another address is refused before they send a password.
- **Trusted proxies.** The app reads forwarded headers (`X-Forwarded-For`, `X-Forwarded-Proto`) only from the sources in `TRUSTED_PROXIES`.
  - `TRUSTED_PROXIES` is a comma-separated list of IP addresses, CIDR ranges, and Compose service names.
  - `*` trusts every source. Only platform services use it, because their proxy is the only way in.
  - In HTTPS mode with an empty `TRUSTED_PROXIES`, the app logs at start that it will refuse every request.
  - Routes see only the request headers on the security check's allow list, plus `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto` as the check sets them. A later ticket that needs another header adds it to that list, and that change gets a security review. Routes see no request trailers.
- `GET /healthz` answers in both modes, from any source and with any `Host`. It shows only health. This lets the Compose health check run from inside the container.
- Every address the app makes, such as setup, invite, and reset links and the links in emails, starts with `APP_URL`.

## Changing `APP_URL`

- A passkey works at one web address only. The app stores each passkey with the `APP_URL` host it was made under.
- At start, the app deletes every passkey that was made under another host.
- Each Member who lost a passkey gets a System notice. They sign in with password plus TOTP and may add a new passkey.
- This covers a restore on a new server under a new address ([Backup, restore, and data export](11-backup-restore-export.md#restore)).

## Encryption at rest

The app encrypts its secrets itself, with AES-256-GCM envelope encryption. It has no full-database encryption in v1. [ADR 0005](../adr/0005-app-level-envelope-encryption.md) records why.

**Master-key secrets** are one class. It has four kinds:

- Bank-data provider secrets: the Plaid secret and every access token;
- AI keys;
- the VAPID keys for web push;
- the SMTP password.

Rules for every Master-key secret:

- The Master key encrypts it.
- A data export never holds it.
- It is lost when the Master key is lost.
- After a restore without the Master key, a Member enters it again. The VAPID keys are the exception: the app makes new ones by itself. Each Member then turns Alerts on again on each device.
- The app never shows a saved secret again. Settings show only that it is set.

How the encryption works:

- The app uses Node's built-in crypto module.
- One random 256-bit data key encrypts every secret with AES-256-GCM. Each encryption uses a random 96-bit IV.
- The additional authenticated data (AAD) binds each ciphertext to its row ID and column name. A ciphertext moved to another row fails to decrypt.
- Each ciphertext starts with a key ID.
- The Master key encrypts the data key with AES-256-GCM. The encrypted data key is stored in `app.db`.
- The app makes the data key at its first start.

What stays readable:

- Everything else in `app.db` is stored as plain data. This includes Transactions, Merchants, and Members' names and email addresses.
- Passwords are stored as hashes. The app holds no full account numbers, because Plaid gives only the last 4 digits.
- The setup guide tells the self-hoster to encrypt the host's disk ([Install and first-run setup](12-install-and-first-run.md#the-setup-guide)).

This protects a leaked backup or a copied `app.db` without the Master key. It does not protect a compromised running host or app.

## The Master key

- The Master key is 32 random bytes, written as 64 hexadecimal characters.
- `fft setup` makes it ([Install and first-run setup](12-install-and-first-run.md#the-fft-command)).
- The app reads the file named by `FFT_MASTER_KEY_FILE`, which defaults to `/run/secrets/master.key`. If that file is missing, the app reads `FFT_MASTER_KEY`.
- The setup guide prefers the file wherever one is possible. Platform dashboards and crash reports can show an environment variable.
- **At start:**
  - With no Master key, the app logs that `fft setup` must run first, and exits.
  - With a Master key that cannot decrypt the stored data key, the app logs the reason and exits. It changes nothing.
  - Only `fft restore` accepts the loss of the old Master key ([Backup, restore, and data export](11-backup-restore-export.md#without-the-master-key)).
- **Shown once.** The wizard's Master key step shows the key, with a Copy button, until the Member presses "I saved it". The app does not ask for the key back. After that, the app never shows the Master key again.
- **"Check my Master key"** in settings: any Member pastes the saved key, and the app says whether it matches.
  - The check ignores spaces, line breaks, and letter case.
  - Settings show when someone last checked.
- The Household keeps a copy in a password manager, off the server. A backup never holds the Master key.
- **Derived values.** The app derives two values from the Master key with HKDF-SHA256, one label per use. It stores neither.
  - The setup code ([Install and first-run setup](12-install-and-first-run.md#the-fft-command)).
  - The login signing secret (below).
- **No rotation in v1.** The key IDs leave room for rotation later.
- **A leaked Master key:** the self-hoster rotates the Plaid secret, the AI keys, and the SMTP password at each provider. A Member then enters the new ones. The setup guide gives the steps.
- **A lost Master key:** history stays, but every Connection must be made again. The full cost is in [Backup, restore, and data export](11-backup-restore-export.md#without-the-master-key).

## Login secrets

- Sessions are signed with the login signing secret, which is derived from the Master key.
- TOTP secrets and backup codes are stored encrypted with that signing secret.
- So a copy of `app.db` alone cannot sign anyone in or forge a session.
- After a restore without the Master key, every session ends and no TOTP code works. The self-hoster runs `fft reset-login` for one Member. That Member resets the others in the app.
- The login library is named in [Stack and architecture](10-stack-and-architecture.md).

## Sources

- [Install and first-run setup](https://github.com/therecluse26/family-finance-tracker-private/issues/21)
- [Stack and storage](https://github.com/therecluse26/family-finance-tracker-private/issues/12)
- [Encrypting a self-hosted database at rest](https://github.com/therecluse26/family-finance-tracker-private/issues/8)
- [Backup, restore, and data export](https://github.com/therecluse26/family-finance-tracker-private/issues/22)
- [Scope and product principles](https://github.com/therecluse26/family-finance-tracker-private/issues/2)
- Research: [Database encryption at rest](https://github.com/therecluse26/family-finance-tracker-private/blob/research/database-encryption/docs/research/database-encryption.md) (branch `research/database-encryption`)
