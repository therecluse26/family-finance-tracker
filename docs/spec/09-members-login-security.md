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

- Any Member can make an invite link, in settings or in the wizard's Invite Members step.
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
- **Failed sign-ins:** the app allows 5 failed sign-ins per 15 minutes, per Member and per IP address. The app refuses further tries in that window without checking them.
- **Sensitive actions** ask for a TOTP code or a backup code again, each time:
  - a data export;
  - removing a Connection;
  - resetting another Member's login;
  - removing a Member;
  - changing the Plaid keys, an AI key, or the SMTP password;
  - changing one's own password or TOTP.

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
| `https://` | Only requests from a trusted proxy that marks them as HTTPS (`X-Forwarded-Proto: https`). It refuses every other request. This fails closed. | Every feature. |
| `http://` | Only requests whose `Host` matches the host and port of `APP_URL`. The `APP_URL` host must be local (below). | Password plus TOTP. Alerts go by email only. Passkeys, the install prompt, and web push are hidden, with a note that explains why. |

- **Local hosts.** In plain-HTTP mode, the `APP_URL` host must be one of these:
  - an address in `127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`, `fe80::/10`, or Tailscale's `100.64.0.0/10`;
  - the name `localhost`;
  - a name that ends in `.local`, `.lan`, `.home.arpa`, or `.internal`.
- At start, the app logs the reason and exits in each of these cases:
  - `APP_URL` is missing;
  - `APP_URL` has a scheme other than `https://` or `http://`;
  - `APP_URL` is `http://` and its host is not local.
- In plain-HTTP mode, a request with any other `Host` gets a page that names the `APP_URL` address. That page holds no sign-in form. So a Member who enters a public address is refused before they send a password.
- **Trusted proxies.** The app reads forwarded headers (`X-Forwarded-For`, `X-Forwarded-Proto`) only from the sources in `TRUSTED_PROXIES`.
  - `TRUSTED_PROXIES` is a comma-separated list of IP addresses, CIDR ranges, and Compose service names.
  - `*` trusts every source. Only platform services use it, because their proxy is the only way in.
  - In HTTPS mode with an empty `TRUSTED_PROXIES`, the app logs at start that it will refuse every request.
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
- **Shown once.** The wizard's Master key step shows the key. The Member must paste it back before the step is done. After that, the app never shows the Master key again.
- **"Check my master key"** in settings: any Member pastes the saved key, and the app says whether it matches. The wizard's paste-back uses the same check.
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
