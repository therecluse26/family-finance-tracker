# Install and first-run setup

A stranger installs the app with one folder, one command, and one link. `fft setup` makes the Master key and prints a one-use setup link. The first-run wizard then asks for 4 required things and lets the rest wait. Updates are a new image and a restart; migrations run by themselves.

## The image

- The image is published on GitHub's container registry as `ghcr.io/therecluse26/family-finance-tracker`.
- It is built for amd64 and arm64, so it runs on a Raspberry Pi or a NAS.
- Each release is pushed under three names: the exact version, the major version (`1`), and `latest`.
- The Compose file uses `:1`, so it gets fixes but never a breaking change.
- The container starts as root. It fixes the owner of `/data`, `/backups`, and `/run/secrets`, then runs as UID 1000.
  - `PUID` and `PGID` change that UID and GID, for a NAS share that needs a set owner.
  - This also covers Railway, Render, and Fly, which mount volumes as root.
- `GET /healthz` answers 200 once migrations finish ([Stack and architecture](10-stack-and-architecture.md)).
- The Compose file uses `restart: unless-stopped`, `init: true`, and a health check on `/healthz`. The init process passes a stop on to the app even while the app still loads, so a stop during the start leaves no running lock.
- The image carries the generated third-party notices file.
- The job runner stays a separate package in the image, as its license requires. It is not bundled into the server file ([Stack and architecture](10-stack-and-architecture.md)).
- Settings show the app's version, a "Source code" link to that exact version, and the "Data sources" page for the Benchmark data.

## The folder

```
family-finance-tracker/
  compose.yaml
  .env              APP_URL, PORT, TRUSTED_PROXIES (optional: PUID, PGID)
  secrets/master.key
  data/             app.db, jobs.db
  backups/
```

| Host folder | Mounted at | Holds |
|---|---|---|
| `secrets/` | `/run/secrets` | `master.key`, the Master key. Outside the data volume. |
| `data/` | `/data` | `app.db` and `jobs.db`. |
| `backups/` | `/backups` | Backups and safety copies ([Backup, restore, and data export](11-backup-restore-export.md#where-backups-go)). It has its own mount, so the self-hoster may point it at a NAS or a synced folder. |

`.env` holds only these settings:

| Setting | Meaning | Default |
|---|---|---|
| `APP_URL` | The address Members open. It sets the security mode ([Members, login, and security](09-members-login-security.md#security-mode)). | None. Required. |
| `PORT` | The port the app listens on, on all network interfaces. | `3000` |
| `TRUSTED_PROXIES` | The proxies whose forwarded headers the app trusts. | Empty |
| `PUID`, `PGID` | The UID and GID the app runs as. | `1000` |

- Members enter everything else in the app: Plaid keys, AI keys, and SMTP settings.
- The SMTP password is a Master-key secret, like the bank and AI keys ([Members, login, and security](09-members-login-security.md#encryption-at-rest)).
- v1 supports only the local database file, `file:/data/app.db`.

## The `fft` command

One command-line tool ships in the image. The self-hoster runs it as `docker compose run --rm app fft <command>`.

### `fft setup`

| State | What `fft setup` does |
|---|---|
| No Master key and no Member | Creates `secrets/master.key` with mode `0600`, and prints the setup link. |
| A Master key, and no Member | Prints the setup link again, instead of refusing. |
| At least one Member | Changes nothing and says setup is done. If no Master key exists, it points to the setup guide's lost-key steps. |

- The setup link looks like `https://money.example.com/setup#code=7KQ2-M9XD-4TRF`. It starts with `APP_URL`.
- Without `APP_URL`, `fft setup` stops and says that `.env` needs it.
- **The code** comes from the Master key, so no second secret is stored.
  - The app derives it with HKDF-SHA256 ([Members, login, and security](09-members-login-security.md#the-master-key)).
  - It is 12 Crockford base32 characters, in 3 groups of 4.
- The code sits after `#`, so the browser never sends it to the server. It stays out of proxy and access logs.
- The code stops working once the first Member exists.
- The app never writes the code to its log.

### `fft setup --app-url <url>`

- For a platform service. It runs on the self-hoster's own computer: `docker run --rm ghcr.io/therecluse26/family-finance-tracker:1 fft setup --app-url <url>`.
- It prints the Master key, to paste into the platform's secrets, and the setup link for `<url>`.
- It writes no file.

### `fft restore <file>`

- The restore command. It runs on the server while the app is stopped.
- Its steps are in [Backup, restore, and data export](11-backup-restore-export.md#restore).

### `fft reset-login <email>`

- The last resort when no Member can sign in.
- It prints a one-use reset link for the Member with that email. The link lasts 24 hours.
- It works while the app runs. The reset rules are in [Members, login, and security](09-members-login-security.md#login-reset).

### Where the Master key comes from

The app reads `FFT_MASTER_KEY_FILE`, which defaults to `/run/secrets/master.key`. If that file is missing, the app reads `FFT_MASTER_KEY`. The setup guide prefers the file wherever one is possible, because platform dashboards and crash reports can show an environment variable.

## HTTPS

The setup guide gives three ways, in this order:

| Way | Use it for | Compose file | `TRUSTED_PROXIES` |
|---|---|---|---|
| 1. **Tailscale Serve** (preferred) | Private access with a real certificate. Passkeys and web push work on phones. | Publishes the app port on `127.0.0.1` only. | The Docker gateway. |
| 2. **Caddy** | A public domain. | Caddy is an optional service in the Compose file. The app port is not published. | Caddy. |
| 3. **Plain HTTP on the home network** | A quick start. | Publishes the app port on the home network. | Empty. |

- Plain HTTP gives no passkeys and no web push. Alerts go by email only ([Members, login, and security](09-members-login-security.md#security-mode)).
- The guide gives the exact `APP_URL` and `TRUSTED_PROXIES` values for each way.

**Plaid Link on plain HTTP:**

- In Plaid's sandbox, a home-network address (`http://192.168.x.x`) and `http://localhost` behaved the same.
- Link opened, bank search and the sandbox sign-in worked, the Accounts appeared, and the OAuth pop-up opened.
- Browser automation stalled at the same final step from both, so the address did not cause the stall. Production was not tested.
- The app allows Plaid Link from a local plain-HTTP address. The guide says to use Tailscale Serve if Link fails there.
- The build tests Plaid Link from a plain-HTTP LAN address once in Production.

## Hosting services

| Kind | Examples | What v1 gives it |
|---|---|---|
| A rented server (VPS) | AWS Lightsail or EC2, a GCP or Azure VM, DigitalOcean, Hetzner | It runs Compose like a home server, with Tailscale Serve or Caddy. It gets the step-by-step guide. |
| A platform service | Render, Railway, Fly.io | One checklist page (below). |
| Serverless containers | Cloud Run, AWS App Runner, Azure Container Apps, Lambda | Out of scope ([Out of scope](13-out-of-scope.md)). They scale to zero and give no lasting local disk, which breaks SQLite and the job runner. |

**The platform checklist:**

- Exactly one instance, because SQLite does not share.
- A persistent volume at `/data`.
- Always on, because free tiers that sleep stop the 6-hour sync.
- The Master key as a platform secret, made with `fft setup --app-url <url>` on the self-hoster's computer.
- `TRUSTED_PROXIES=*`, because the platform's proxy is the only way in.
- Backups share the disk: with no `/backups` mount, the app writes them to `/data/backups`. The self-hoster must download them now and then.

## The first-run wizard

The wizard has 6 steps. Each step shows "Step N of 6", the name of each step, and Back.

| Step | Required | Content |
|---|---|---|
| 1. Setup link | Yes | The code from `fft setup`'s link. |
| 2. Your login | Yes | Name, email, password, TOTP, and backup codes. This makes the first Member. |
| 3. Master key | Yes | Shown with a Copy button until the Member presses "I saved it". |
| 4. Household | Yes | The ZIP code, each person's age (people without a login included, such as children), and rent or own. |
| 5. Banks | No | Plaid keys, then Plaid Link for each bank. Done only when a Connection exists. |
| 6. Finish | — | History loading, and the optional extras. |

**Order and resume rules:**

- Until steps 1 to 4 are done, every page leads to the wizard, except `/healthz`.
- The Master key step comes before the Banks step on purpose, so no token is stored before the key is saved.
- Only the Banks step can be skipped, with "Skip for now". A skipped Banks step appears in the "Finish setup" list on the dashboard until a Connection exists.
- In the list of steps, a done step has a check mark. A skipped Banks step has no check mark: it shows "5. Banks (skipped)".
- AI, Alerts, and Invite Members are not wizard steps. They are optional extras. Each one appears in the "Finish setup" list until it is done, and the Finish step lists the ones not yet done.
- The wizard saves each step when the step is done. The next visit opens the first step that is neither done nor skipped.
- Back opens the step before. A step whose work cannot change, such as the login or the saved Master key, then says that it is done and offers Continue.
- Each button names where it goes, such as "Continue to the Master key" or "Save and continue to Banks".
- Only the first Member goes through the wizard. A Member who joins by invite never sees it; they only make their own login.

**Step 1, Setup link:**

- The setup page reads the code from the part after `#`. Without it, the page asks the Member to enter the code.
- Entered codes ignore letter case and dashes.
- The page allows 5 wrong codes per 15 minutes.
- After the server accepts the code, the page keeps it in the browser tab's session storage, exactly as the server accepted it. A reload then goes on to step 2 without the code from the terminal. The page checks the kept code with the server again before it uses it.
- The page deletes the kept code when the first Member exists, and when the server refuses the code itself: a wrong code, a code with the wrong form, or a code sent after the first Member exists. The page keeps the code after "too many wrong codes" and after a server error, because the code can still be right. Closing the tab also deletes it.

**Step 2, Your login:**

- The step makes the first Member and signs them in. It shows the backup codes once. From then on, the setup code no longer works. Login rules are in [Members, login, and security](09-members-login-security.md#signing-in).
- The page keeps the Name and Email typed so far in the tab's session storage with the setup code, so a reload does not empty them. It deletes them whenever it deletes the kept code. It never keeps the password.

**Step 3, Master key:**

- The step shows the Master key on each visit, with a Copy button, until the Member presses "I saved it".
- The app does not ask the Member to paste the key back. "Check my Master key" in settings tests a saved copy later ([Members, login, and security](09-members-login-security.md#the-master-key)).
- After "I saved it", the app never shows the Master key again.

**Step 4, Household:** how the app uses these facts, and how Members edit them later, is in [Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md).

**Step 5, Banks:**

- The step takes the Plaid keys, then offers Plaid Link for each bank. Under `pnpm dev`, it also offers the fake bank.
- The step is done only when app.db holds a Connection. The server decides this. Until then, Continue is off.
- "Skip for now" lets a self-hoster go on without a Connection, such as before Plaid approves the Trial plan. The Banks item then waits in the "Finish setup" list. Until a Connection exists, the dashboard shows "Link a bank to see your money here" in place of its boxes ([Dashboard and pages](07-dashboard-and-pages.md#the-dashboard)).
- Unconnected accounts, Manual loans, and Import Plaid Connection are not in the wizard. They are in Settings, Banks. They do not make the Banks step done.
- Every rule for these is in [Accounts and bank sync](02-accounts-and-bank-sync.md).
- The step offers no sandbox dry run, because sandbox data would mix with real data.

**Step 6, Finish:**

- The Finish step says that history is loading. The dashboard shows progress per Connection.
- When every Connection's history is in, the AI's first run starts and the formula drafts the Budgets ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md), [AI](08-ai.md)).
- Then one System notice says "Your history is ready".
- If the Household has no Connection yet, the Finish step says so and points to the "Finish setup" list.
- Below "Open the dashboard", the step lists each optional extra not yet done, with a link to its settings page:
  - **AI helper:** the [AI settings page](08-ai.md#ai-settings-page). The step shows the estimate for the first AI run on all history: about $0.20, counted against the AI cost cap ([AI](08-ai.md#the-ai-cost-cap)).
  - **Alerts by email:** Settings, Alerts ([Anomalies and Alerts](06-anomalies-and-alerts.md#recipients-and-channels)).
  - **Invite Members:** invite links under the rules in [Members, login, and security](09-members-login-security.md#invites).
- "Open the dashboard" and each extra's link end the wizard.

**The "Finish setup" list:**

- The dashboard shows it to every Member, once steps 1 to 4 are done ([Dashboard and pages](07-dashboard-and-pages.md#header-and-status-lines)).
- It holds Banks while the Household has no Connection (a removed Connection does not count), then AI, Alerts, and Invite Members, each until it is done.
- An item is done only on what the server knows. The Banks step is done once a Connection exists. AI is done once an AI provider is set. Alerts is done once a test email goes out. Invite Members is done once an invite link is made.
- A done extra stays done, even if its provider or invite goes away later. A done Banks step also stays done, but Banks comes back to the list when the last Connection is removed.

## Updates

- To update: `docker compose pull && docker compose up -d`.
- At start, migrations run by themselves, after a safety copy ([Backup, restore, and data export](11-backup-restore-export.md#when-backups-run)).
- The app refuses to start on a database that holds a migration its image does not have. It logs why.
- Once a day, the app checks GitHub for a newer release. Settings then show "Update available", with the new version.
  - The check sends no Household data.
  - The check is on by default. Any Member can turn it off in settings.
  - For a new major version, settings also say that the image version in `compose.yaml` must change, and link to the release notes.

## The setup guide

- The README has a quick start of about 5 commands. It fetches `compose.yaml` and an example `.env`, sets `APP_URL`, runs `fft setup`, starts the app, and opens the setup link.
- `docs/self-hosting.md` holds the full guide:
  - the three HTTPS ways;
  - the step-by-step guide for a rented server;
  - the platform checklist;
  - Plaid sign-up;
  - the `fft` commands;
  - updates;
  - restore, and the steps for a lost or leaked Master key ([Members, login, and security](09-members-login-security.md#the-master-key));
  - encrypting the host's disk, such as with LUKS on Linux.

**Cautions the guide states:**

- The backup folder holds readable history, so use an encrypted disk.
- Keep a copy of `compose.yaml` and `.env`, because backups do not include them.
- Save the Master key in a password manager. "Check my Master key" in settings tests the saved copy.
- Prefer the Master key file to `FFT_MASTER_KEY`.
- If Plaid Link fails on plain HTTP, use Tailscale Serve.

**No reset command.** Deleting `data/` loses every Plaid token, and connecting again spends new Items. The guide says to restore a backup instead, never to delete `data/`. A restore with the Master key keeps every Connection.

**Plaid sign-up steps:**

1. Sign up at https://dashboard.plaid.com/ and verify the email.
2. Apply for the Trial plan at https://dashboard.plaid.com/trial-plan. Plaid checks your ID.
3. Copy the client ID and Production secret from the Dashboard's Keys page.

Catches:

- The Trial plan is for US or Canada teams created on or after April 15, 2026.
- It allows 10 Items for life. Removing one does not free its slot.

## Sources

- [Install and first-run setup](https://github.com/therecluse26/family-finance-tracker-private/issues/21)
- [Backup, restore, and data export](https://github.com/therecluse26/family-finance-tracker-private/issues/22)
- [Stack and storage](https://github.com/therecluse26/family-finance-tracker-private/issues/12)
- [Software license](https://github.com/therecluse26/family-finance-tracker-private/issues/23), for the image and settings
- [Compare Plaid's Trial plan and SimpleFIN Bridge on real Accounts](https://github.com/therecluse26/family-finance-tracker-private/issues/10) and [Plaid free tier for a self-hosted personal app](https://github.com/therecluse26/family-finance-tracker-private/issues/3), for Plaid sign-up
