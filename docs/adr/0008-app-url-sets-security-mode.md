# `APP_URL` sets the security mode; every Member has a password plus TOTP

The app runs over HTTPS, or over plain HTTP on a home network as a quick start. Something must decide which mode applies, and plain HTTP must never reach the public internet. Checking each client's network address does not work. Docker Desktop and rootless Docker rewrite that address, so every request looks local. A public request would then pass as local, and the check would fail open.

`APP_URL` sets the mode. With `https://`, the app accepts only requests that arrive through a trusted proxy as HTTPS, so a wrong setup fails closed. With `http://`, the `APP_URL` host must be a local address, or a name that ends in `.local`, `.lan`, `.home.arpa`, or `.internal`. Each request's `Host` must then match `APP_URL`. So a Member who enters a public address is refused before they send a password. The setting is under the self-hoster's control and does not depend on Docker's networking.

Every Member has a password plus TOTP. A passkey is an optional extra, added in settings over HTTPS. A passkey works at one web address only. A restore or a move under a new address would lock out a Member whose only login was a passkey. Plain-HTTP mode cannot use passkeys at all. When the `APP_URL` host changes, the app deletes the passkeys made under the old host and tells each Member. They then sign in with password plus TOTP. The rules are in [Members, login, and security](../spec/09-members-login-security.md#security-mode).

## Considered options

- **The client's network address decides the mode.** Rejected: Docker rewrites that address.
- **Login by passkey, or by password plus TOTP.** Rejected: a Member with only a passkey loses access when the address changes.

Sources: [Install and first-run setup](https://github.com/therecluse26/family-finance-tracker-private/issues/21), [Stack and storage](https://github.com/therecluse26/family-finance-tracker-private/issues/12), [Scope and product principles](https://github.com/therecluse26/family-finance-tracker-private/issues/2), [Backup, restore, and data export](https://github.com/therecluse26/family-finance-tracker-private/issues/22).
