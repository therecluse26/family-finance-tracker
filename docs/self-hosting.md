# Self-hosting guide

This guide installs Family Finance Tracker for one Household, keeps it running, and brings it back when something goes wrong. The short version is the [quick start in the README](../README.md#quick-start).

Every key, token, address, and email address in this guide is a placeholder, such as `money.example.com`, `192.168.1.20`, or `member@example.com`. Put in your own.

- [What you need](#what-you-need)
- [Install with Docker Compose](#install-with-docker-compose)
- [HTTPS: three ways](#https-three-ways)
- [A rented server](#a-rented-server)
- [A platform service](#a-platform-service)
- [Plaid sign-up](#plaid-sign-up)
- [The `fft` commands](#the-fft-commands)
- [Backups](#backups)
- [Restore](#restore)
- [The Master key](#the-master-key)
- [Updates](#updates)
- [Encrypt the host's disk](#encrypt-the-hosts-disk)
- [When something goes wrong](#when-something-goes-wrong)

## What you need

- A computer that is always on: a home server, a NAS, a Raspberry Pi with a 64-bit system, or a rented server. The image runs on amd64 and arm64.
- Docker Engine with Compose v2, so that `docker compose version` works.
- To connect banks: a Plaid account on the Trial plan ([Plaid sign-up](#plaid-sign-up)).
- Optional: an AI provider's API key, and an SMTP account for Alert emails. Members enter both in the app.

**Cautions:**

- **Exactly one app per data folder.** Two app containers must never share one `data/` folder. SQLite does not share. A second app refuses to start while the first one runs.
- **Keep the app private until setup is done.** Until the first Member exists, anyone who can reach the app can send wrong setup codes. The setup page allows 5 wrong codes per 15 minutes, so a stranger can keep you locked out. Tailscale Serve and plain HTTP on the home network are private. Finish the wizard's steps 1 and 2 (the setup link and the first Member) before the app is reachable from the internet. With Caddy on a public domain, finish setup right after the first start.
- **There is no reset command.** Never delete `data/` to start over: it holds every Plaid token, and connecting the banks again spends new Plaid Items, which are limited for life. Restore a backup instead ([Restore](#restore)).

## Install with Docker Compose

These steps work on any computer with Docker. On a rented server, first follow [A rented server](#a-rented-server).

### 1. Make the folder

```sh
mkdir family-finance-tracker && cd family-finance-tracker
curl -fsSL -O https://raw.githubusercontent.com/therecluse26/family-finance-tracker/v1.0.0/compose.yaml \
  -O https://raw.githubusercontent.com/therecluse26/family-finance-tracker/v1.0.0/.env.example
cp .env.example .env
```

Keep the folder's name. The app's Docker network is named after it (`family-finance-tracker_default`), and the Tailscale Serve steps use that name.

The folder ends up like this:

```
family-finance-tracker/
  compose.yaml
  .env              APP_URL, PORT, TRUSTED_PROXIES (optional: PUID, PGID)
  secrets/master.key
  data/             app.db, jobs.db, app.lock
  backups/
```

| Folder | In the container | Holds |
|---|---|---|
| `secrets/` | `/run/secrets` | `master.key`, the Master key |
| `data/` | `/data` | `app.db`, the Household's data, and `jobs.db`, the job list |
| `backups/` | `/backups` | Daily backups and safety copies. You may point this mount at a NAS or a synced folder in `compose.yaml` |

Keep a copy of `compose.yaml` and `.env` off the server, such as next to the Master key in your password manager. Backups do not include them. Neither holds a secret.

### 2. Choose how Members reach the app

Pick one of the [three HTTPS ways](#https-three-ways), and set `APP_URL` and `TRUSTED_PROXIES` in `.env` as that way says. `APP_URL` is the address Members open. It also sets the security mode:

- An `https://` address gives every feature. The app then accepts only requests from a proxy in `TRUSTED_PROXIES` that marks them as HTTPS.
- An `http://` address must be a local one. It gives no passkeys and no web push, so Alerts go by email only.

To try the app on one computer, `APP_URL=http://localhost:3000` with an empty `TRUSTED_PROXIES` works with no other change. Only that computer can open it.

### 3. Make the Master key

```sh
docker compose run --rm app fft setup
```

It makes `secrets/master.key` with mode `0600` and prints the setup link:

```
Made the Master key in /run/secrets/master.key.
...
Open this setup link to make the first Member. It stops working once the first Member exists:
  https://money.example.com/setup#code=XXXX-XXXX-XXXX
```

The code after `#` comes from the Master key. Your browser never sends it to the server, so it stays out of logs. Lost the link? Run `fft setup` again: until the first Member exists, it prints the same link. While the app runs, run it in the running container:

```sh
docker compose exec app fft-entrypoint --no-chown fft setup
```

### 4. Start the app

```sh
docker compose up -d
docker compose ps
```

The app is ready when `docker compose ps` shows it as `healthy`. The first start applies the migrations and makes the first backup. `docker compose logs app` shows its log.

### 5. Open the setup link

Open the link from step 3 in your browser. The first-run wizard has 6 steps. It asks for 4 things and lets the banks wait:

| Step | Required | What you do |
|---|---|---|
| 1. Setup link | Yes | The code comes from the link. Without it, type the code. If you reload the page, the tab keeps the code. |
| 2. Your login | Yes | Your name, email, and password. Scan the QR code with an authenticator app, and save the backup codes. |
| 3. Master key | Yes | The wizard shows the Master key once. Copy it into a password manager, then press "I saved it". |
| 4. Household | Yes | The ZIP code, each person's age, and rent or own. |
| 5. Banks | No | The Plaid keys, then link each bank. "Skip for now" lets you link them later. |
| 6. Finish | | History starts loading. |

AI, email Alerts, and invites for the rest of the Household are optional extras. The Finish step lists them, and so does a "Finish setup" list on the dashboard, until each is done. Banks waits in the same list while no bank is linked.

### 6. Protect the data

- Encrypt the disk that holds the folder ([Encrypt the host's disk](#encrypt-the-hosts-disk)). `data/` and `backups/` hold readable history.
- Test the saved Master key now: Settings, Backups and data, "Check my master key".

## HTTPS: three ways

Use the first way that fits.

| Way | Use it for | `APP_URL` | `TRUSTED_PROXIES` |
|---|---|---|---|
| 1. Tailscale Serve (preferred) | Private access with a real certificate. Passkeys and web push work on phones. | `https://<machine-name>.<tailnet-name>.ts.net` | The Docker gateway, such as `172.18.0.1` |
| 2. Caddy | A public domain. | `https://money.example.com` | `caddy` |
| 3. Plain HTTP on the home network | A quick start. | `http://192.168.1.20:3000` | Empty |

`TRUSTED_PROXIES` lists only your proxy's own address. The app reads `X-Forwarded-For` and `X-Forwarded-Proto` only from the sources it lists. With an `http://` `APP_URL`, the app refuses to start when `TRUSTED_PROXIES` is `*` or covers every address.

With an `https://` `APP_URL`, the proxy must pass on the browser's own `Host`. The app answers any other host with 421, even from a trusted proxy. Tailscale Serve keeps the `Host` as it is, and so does the Compose file's `caddy reverse-proxy` command unless `--change-host-header` is added to it. nginx sends the app's own address by default, so an nginx proxy needs `proxy_set_header Host $host;`.

### 1. Tailscale Serve (preferred)

Tailscale gives the server a private name and a real certificate. Only devices signed in to your tailnet can reach it. Each Member installs the Tailscale app on their phone and computer.

1. Install Tailscale on the server, from <https://tailscale.com/download>, and sign it in: `sudo tailscale up`.
2. In the Tailscale admin console, under DNS, turn on MagicDNS and HTTPS Certificates.
3. Keep `compose.yaml` as it is. It publishes the app port on `127.0.0.1` only, so nothing outside the server reaches it except through Tailscale.
4. Make the folder and run `fft setup` as in [Install with Docker Compose](#install-with-docker-compose), with this `APP_URL`:

   ```
   APP_URL=https://<machine-name>.<tailnet-name>.ts.net
   ```

5. Find the Docker gateway of the app's network. `fft setup` made the network.

   ```sh
   docker network inspect family-finance-tracker_default --format '{{(index .IPAM.Config 0).Gateway}}'
   ```

   Put the address it prints in `.env`:

   ```
   TRUSTED_PROXIES=172.18.0.1
   ```

   Tailscale Serve sends each request to `127.0.0.1:3000`, and Docker passes it to the app from this gateway address. Serve keeps the `ts.net` name as the `Host`, which must match `APP_URL`.

6. Start the app with `docker compose up -d`, then turn on Tailscale Serve:

   ```sh
   sudo tailscale serve --bg http://127.0.0.1:3000
   ```

7. Open the setup link from a device on your tailnet.

The gateway stays the same while the network exists. `docker compose down` deletes the network, and the next start may get another address. Use `docker compose stop` and `docker compose up -d` instead. If every page is refused after a `down`, find the gateway again ([When something goes wrong](#when-something-goes-wrong)).

### 2. Caddy

Caddy is an optional service in `compose.yaml`. It gets a certificate for `APP_URL`'s host by itself.

1. Point a domain name at the server: a DNS `A` record (and `AAAA` for IPv6) for `money.example.com`.
2. Open ports 80 and 443 to the server.
3. In `compose.yaml`, delete the app's two `ports` lines, so only Caddy reaches the app.
4. In `.env`:

   ```
   APP_URL=https://money.example.com
   TRUSTED_PROXIES=caddy
   ```

   `caddy` is Caddy's service name. The app trusts the address it resolves to. The Caddy service's `caddy reverse-proxy` command keeps the browser's `Host`; do not add `--change-host-header` to it.

5. Run `fft setup`, then start the app and Caddy:

   ```sh
   docker compose run --rm app fft setup
   docker compose --profile caddy up -d
   ```

6. Open the setup link at once, and finish wizard steps 1 to 4. The app is public, so anyone can reach the setup page until the first Member exists.

Add `--profile caddy` whenever you start everything, such as after `docker compose down`. `docker compose up -d` alone starts the app and leaves Caddy as it is.

### 3. Plain HTTP on the home network

The quickest way, for devices on your home network only.

1. In `compose.yaml`, change `127.0.0.1` to `0.0.0.0` in the app's `ports` line:

   ```yaml
       ports:
         - 0.0.0.0:${PORT:-3000}:${PORT:-3000}
   ```

2. In `.env`, use the server's address on the home network, and leave `TRUSTED_PROXIES` empty:

   ```
   APP_URL=http://192.168.1.20:3000
   TRUSTED_PROXIES=
   ```

   The host must be local: an address in `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `127.0.0.0/8`, `fc00::/7` or `fe80::/10`, `localhost`, or a name that ends in `.local`, `.lan`, `.home.arpa`, or `.internal`.

3. Give the server a fixed address in your router, such as a DHCP reservation. Members must open exactly `APP_URL`. Any other address gets a page that names it.
4. Never forward the port on your router.

What plain HTTP lacks:

- No passkeys, no install prompt, and no web push. Alerts go by email only.
- **If Plaid Link fails on plain HTTP, use Tailscale Serve.** Link worked from a plain-HTTP home-network address in Plaid's sandbox, but it has not been tested in Production.

## A rented server

A rented server (VPS), such as AWS Lightsail or EC2, a GCP or Azure VM, DigitalOcean, or Hetzner, runs Compose like a home server.

1. **Rent a Linux server** with a current Ubuntu LTS or Debian, on amd64 or arm64. If the provider offers an encrypted disk or encrypted volumes, turn it on. Otherwise plan to put the folder on a LUKS volume ([Encrypt the host's disk](#encrypt-the-hosts-disk)).
2. **Sign in with an SSH key**, as a user that is not root and can use `sudo`.
3. **Turn on security updates.** On Ubuntu or Debian:

   ```sh
   sudo apt update && sudo apt install --yes unattended-upgrades
   ```

4. **Set the provider's firewall.** Allow SSH only. With Caddy, also allow ports 80 and 443. Use the provider's own firewall: ports that Docker publishes on all addresses skip `ufw` on the server. Tailscale needs no open port.
5. **Install Docker Engine** with the Compose plugin, from Docker's steps for your system: <https://docs.docker.com/engine/install/>. Run the commands in this guide with `sudo`, or as a user in the `docker` group. That group has root's powers.
6. **Choose the HTTPS way.** Tailscale Serve keeps the app private, and needs no domain. Caddy needs a domain and makes the app public.
7. **Install** as in [Install with Docker Compose](#install-with-docker-compose), with the steps of the way you chose.
8. **Copy backups off the server** now and then ([Backups](#backups)). A rented server can be lost with its disk.

## A platform service

Render, Railway, and Fly.io run the image without Compose. They get this checklist:

- [ ] **Exactly one instance.** SQLite does not share. Turn off scaling and turn off running a second copy during a deploy, if the platform allows it.
- [ ] **A persistent volume at `/data`.**
- [ ] **Always on.** A free tier that sleeps stops the 6-hour sync.
- [ ] **The Master key as a platform secret.** Make it on your own computer:

  ```sh
  docker run --rm ghcr.io/therecluse26/family-finance-tracker:1 fft setup --app-url https://<your-app-address>
  ```

  It prints a new Master key and the setup link for that address, and writes no file. Save the key in your password manager. If the platform has secret files, add the key as a file and set `FFT_MASTER_KEY_FILE` to its path; the app's user (UID 1000) must be able to read it. Otherwise set it as the secret `FFT_MASTER_KEY`. Prefer the file: platform dashboards and crash reports can show an environment variable.
- [ ] **`APP_URL`** set to the platform's `https://` address for the app: the host the platform serves it under, or the app answers 421.
- [ ] **`TRUSTED_PROXIES=*`.** The platform's proxy is the only way in.
- [ ] **Backups in `/data/backups`.** With no `/backups` mount, the app writes backups there, on the same disk as the data. Download them now and then with the platform's own file copy tool, such as `fly ssh sftp get` on Fly.io.

The image is `ghcr.io/therecluse26/family-finance-tracker:1`. It listens on `PORT` (default `3000`), and `GET /healthz` answers 200 once the app is ready.

**Serverless containers are not supported:** Cloud Run, AWS App Runner, Azure Container Apps, and Lambda. They scale to zero and give no lasting local disk, which breaks SQLite and the job runner.

**Restore on a platform** needs the app stopped and `fft restore` run on the same volume. If the platform gives no shell on the volume while the app is stopped, restore on your own computer with Compose:

1. Make the folder on your computer ([Install with Docker Compose](#install-with-docker-compose)), but do not run `fft setup`. Set `APP_URL` in `.env` to the platform's address: Compose refuses an empty one.
2. Put the same Master key in `secrets/master.key` ([The server is gone, the Master key is saved](#the-server-is-gone-the-master-key-is-saved)).
3. Download the backup from the platform's `/data/backups`, and copy it into `backups/` with its name.
4. Run `fft restore` on it ([Restore](#restore)). Do not start the app there.
5. Stop the platform's app. Download its current `/data/app.db` and keep it: this way makes no `restore` safety copy.
6. Replace `/data/app.db` on the volume with the restored `data/app.db`, and delete these files on the volume if they exist: `app.db-wal`, `app.db-shm`, `jobs.db`, `jobs.db-wal`, and `jobs.db-shm`. Then start the platform's app.

## Plaid sign-up

The app connects banks through Plaid's Production environment, on Plaid's free Trial plan.

1. Sign up at <https://dashboard.plaid.com/> and verify the email.
2. Apply for the Trial plan at <https://dashboard.plaid.com/trial-plan>. Plaid checks your ID.
3. Copy the client ID and the Production secret from the Dashboard's Keys page.

Then enter them in the wizard's Banks step, or later in Settings, Banks: "Client ID" and "Production secret". The app stores the secret encrypted with the Master key, and never shows it again.

**Catches:**

- The Trial plan is for US or Canada teams created on or after April 15, 2026.
- It allows 10 Items for life. Each Connection is one Item. Removing one does not free its slot, so connect only the banks you mean to keep.

## The `fft` commands

The `fft` command ships in the image.

| Command | What it does |
|---|---|
| `fft setup` | Makes the Master key, if there is none, and prints the one-use setup link. After the first Member exists, it changes nothing. |
| `fft setup --app-url <url>` | Prints a new Master key and the setup link for `<url>`, for a platform service. It writes no file. |
| `fft reset-login <email>` | The last resort when no Member can sign in. It prints a one-use reset link for the Member with that email. The link lasts 24 hours. |
| `fft restore <file>` | Restores a backup, while the app is stopped ([Restore](#restore)). |

How to run them:

- **While the app is stopped**, or before its first start: `docker compose run --rm app fft <command>`.
- **While the app runs**, such as for `fft reset-login`:

  ```sh
  docker compose exec app fft-entrypoint --no-chown fft reset-login member@example.com
  ```

  This runs the command as the app's user, in the running container. `docker compose run` would start a second container that changes the owners of the folders while the app writes to them.

Never use `docker compose exec app sh`. The container starts as root, so that gives a root shell. Run any command in the container as `docker compose exec app fft-entrypoint --no-chown <command>`.

## Backups

- The app copies `app.db` into `backups/` every day at 3:00 AM, Household time. If the server was off, it makes the missed backup at its next start.
- It also makes a safety copy before each update's migrations and during each restore.
- It keeps the newest 7 daily or manual backups and the newest 3 safety copies, and deletes older ones by itself.
- Settings, Backups and data, shows the last backup and the folder in use, and has "Back up now".
- If a daily backup fails twice, every Member gets a System notice.

A backup is a gzipped SQLite file, named by its time (in UTC) and kind, such as `app-20261102T080000Z-daily.db.gz`. The kinds are `daily`, `manual`, `migration`, and `restore`.

**Cautions:**

- **The backup folder holds readable history:** Transactions, Merchants, and Members' names and email addresses. Keep it on an encrypted disk, and copy it only to places you trust. The bank, AI, and SMTP secrets inside stay encrypted with the Master key.
- **A backup never holds the Master key**, `compose.yaml`, or `.env`. Keep those yourself.
- **Copy backups off the server** now and then, such as to a NAS or another computer. You may also point the `backups` mount in `compose.yaml` at a NAS or a synced folder.
- The files belong to the app's user (UID 1000, or `PUID`) with mode `0600`, and the `data/`, `backups/`, and `secrets/` folders with mode `0700`, so no other user on the host can read them. Copy them as that user, or with `sudo`. To own them as your own user, set `PUID` and `PGID` in `.env` to the numbers from `id -u` and `id -g`.

Settings, Backups and data, also has "Download my data": a ZIP file of CSV and JSON for your own use. It holds no secret, and `fft restore` does not read it.

## Restore

A restore puts a backup in place of `app.db`. It is a command on the server, never a web page.

1. Stop the app. Never pause it with `docker compose pause`: a paused app stops refreshing its lock in `data/app.lock`, and after 30 seconds a restore would run under it.

   ```sh
   docker compose stop app
   ```

2. Choose a backup:

   ```sh
   ls backups/
   ```

3. Restore it:

   ```sh
   docker compose run --rm app fft restore app-20261102T080000Z-daily.db.gz
   ```

4. Start the app:

   ```sh
   docker compose up -d
   ```

`fft restore` takes only a file name in the app's own backup form, `app-<time>-<kind>.db.gz`, from the backup folder. To restore a backup from somewhere else, copy it into `backups/` first, and keep its name.

What `fft restore` does:

- It refuses while the app runs, and changes nothing.
- It checks the file, and refuses a damaged one or one from a newer version of the app. A backup from an older version is fine: the migrations run at the next start.
- It saves the current `app.db` as a `restore` safety copy, puts the backup in place, and empties `jobs.db`. The app schedules missed work again at start.
- With the matching Master key, every secret and every Connection is kept. Sync continues from where the backup left it.
- Without it, it lists the secrets that will be lost, and goes on only if you type `yes` ([A lost Master key](#a-lost-master-key)).

Member changes made after the backup, such as hand-set Categories, are lost. Synced Transactions come back by themselves.

**On a new server**, put the Master key in `secrets/master.key` before the restore ([The server is gone, the Master key is saved](#the-server-is-gone-the-master-key-is-saved)). If `APP_URL` changes, each passkey stops working, and the app deletes it at start. Members sign in with password and TOTP, and may add a new passkey.

**After a crash**, a power cut, `docker kill`, or a stop that took more than 10 seconds, `fft restore` says the app is running for up to 30 seconds. Wait 30 seconds and try again. A normal stop releases the lock, also while the app is still starting.

## The Master key

The Master key is 64 hexadecimal characters. It encrypts the Plaid secret and tokens, the AI keys, the SMTP password, and the web push keys. It also signs logins.

- The app reads it from `secrets/master.key` (`FFT_MASTER_KEY_FILE`, default `/run/secrets/master.key`). If that file is missing, it reads `FFT_MASTER_KEY`.
- **Prefer the file to `FFT_MASTER_KEY`.** Platform dashboards and crash reports can show an environment variable.
- Keep the file readable only by the app's user (mode `0600`).
- **Save it in a password manager**, off the server. The wizard shows it once, in step 3. Test the saved copy now and then with "Check my master key" in Settings, Backups and data.
- v1 has no command to change the Master key.

### A lost Master key

Without the Master key, history stays, but every saved secret is lost. Every Connection becomes Broken, and each bank must be linked again as a new Plaid Item. The Trial plan's 10 Items are for life, so a Household with many banks may run out.

**The server still runs, the key is lost**, such as a deleted `secrets/master.key`:

1. Stop the app: `docker compose stop app`.
2. Restore the newest backup. With no Master key, `fft restore` makes a new one:

   ```sh
   docker compose run --rm app fft restore app-20261102T080000Z-daily.db.gz
   ```

3. Save the new Master key it prints in your password manager. It prints it only once.
4. Read the list of secrets that will be lost, and type `yes`.
5. Start the app: `docker compose up -d`.
6. No session and no TOTP code works now. Make a reset link for one Member:

   ```sh
   docker compose exec app fft-entrypoint --no-chown fft reset-login member@example.com
   ```

7. That Member opens the link, sets a new password and TOTP, then resets the other Members in Settings, Members.
8. Enter again: the Plaid secret in Settings, Banks; the AI key in Settings, AI; the SMTP password in Settings, Alerts.
9. Link each bank again with "Link again" in Settings, Banks. Each Member turns Alerts on again on each device.

Every Member sees a System notice that lists what to set up again. Changes made after the newest backup are lost.

**The server is gone and so is the key:** make the folder on a new server ([Install with Docker Compose](#install-with-docker-compose)), but do not run `fft setup`. Make the backup folder with `mkdir -p backups`, copy a backup into it, then follow the steps above from step 2.

### The server is gone, the Master key is saved

1. Make the folder on the new server ([Install with Docker Compose](#install-with-docker-compose)), with your saved `compose.yaml` and `.env`. Do not run `fft setup`.
2. Put the Master key in place. Paste it into the file with a text editor, so it stays out of the shell's history:

   ```sh
   mkdir -p secrets && chmod 700 secrets
   nano secrets/master.key
   chmod 600 secrets/master.key
   ```

3. Make the backup folder, then copy a backup into it, and keep its name:

   ```sh
   mkdir -p backups
   ```

4. Restore it and start the app:

   ```sh
   docker compose run --rm app fft restore app-20261102T080000Z-daily.db.gz
   docker compose up -d
   ```

Every Connection and secret is kept.

### A leaked Master key

Someone with the Master key and a copy of `app.db` or a backup can read the saved secrets. Change each one at its provider, then enter the new one in the app:

1. **Plaid:** on the Dashboard's Keys page, make a new Production secret. Enter it in Settings, Banks. The Connections keep working.
2. **AI:** revoke the API key at the AI provider, make a new one, and enter it in Settings, AI.
3. **SMTP:** change the mail account's password, and enter it in Settings, Alerts.

The Master key also signs logins. If someone who can reach the app may have it, move to a new Master key: press "Back up now" in Settings, Backups and data, so the newest backup holds today's changes. Then stop the app, move `secrets/master.key` off the server, and restore that `manual` backup as in [A lost Master key](#a-lost-master-key). That costs a new Plaid Item for each bank.

## Updates

```sh
docker compose pull && docker compose up -d
```

- `compose.yaml` uses the image `:1`, so it gets fixes but never a breaking change.
- At start, the app makes a `migration` safety copy, then runs the migrations by itself.
- Settings, About, shows "Update available" when a newer release exists. The check runs once a day, sends no Household data, and can be turned off there.
- **A new major version** needs a change in `compose.yaml`, such as `:1` to `:2`. Read the release notes first.

**Going back to an older version:** an older image refuses to start on an `app.db` that a newer version migrated. To go back:

1. Change the image in `compose.yaml` to the exact older version, such as `ghcr.io/therecluse26/family-finance-tracker:1.2.3`.
2. Stop the app, restore the `migration` safety copy from before the update, and start the app ([Restore](#restore)). Changes made since the update are lost.

## Encrypt the host's disk

The app encrypts its secrets itself, but the rest of `app.db` and every backup is readable: Transactions, Merchants, and Members' names and email addresses. Encrypt the disk that holds the folder.

- **Linux:** choose full-disk encryption (LUKS) when you install the system. It is the simplest. A server then needs the passphrase at each boot.
- **Linux, a second disk or volume:** put the folder on a LUKS volume. This erases the volume `/dev/sdX`:

  ```sh
  sudo cryptsetup luksFormat /dev/sdX
  sudo cryptsetup open /dev/sdX fft-data
  sudo mkfs.ext4 /dev/mapper/fft-data
  sudo mkdir -p /srv/family-finance-tracker
  sudo mount /dev/mapper/fft-data /srv/family-finance-tracker
  ```

  After each boot, open and mount it again before you start the app. Keep the LUKS passphrase in your password manager.
- **macOS:** FileVault. **Windows:** BitLocker.
- **A NAS:** an encrypted shared folder or volume.
- **A rented server:** the provider's encrypted disk or volume, or a LUKS volume as above.

## When something goes wrong

Start with the app's log:

```sh
docker compose logs --tail 100 app
docker compose ps
```

| What you see | What to do |
|---|---|
| The app takes about 30 seconds to start after a crash, a power cut, or `docker kill`, and the log says "Waiting for the running lock to go stale". | This is expected. The app waits until the lock it left in `data/app.lock` goes stale, for at most 40 seconds. A normal stop does not leave the lock, also while the app is starting. A stop that takes more than 10 seconds can. |
| `fft restore` says "The app is running" right after a crash, or after a stop that took more than 10 seconds. | Wait 30 seconds and try again. |
| "Another app process on this data folder keeps the running lock fresh". | A second app uses the same `data/` folder. Stop the other one. Two apps must never share one `data/` folder. |
| "There is no Master key". | Before setup: run `fft setup`. After setup: put the saved key back in `secrets/master.key`, or follow [A lost Master key](#a-lost-master-key). |
| "The Master key cannot decrypt the data key in app.db". | The key is not the one this `app.db` was set up with. Put the right key back. Only `fft restore` goes on without it. |
| "app.db holds a migration that this version of the app does not have", or "holds 2 migrations" or more. | A newer version ran on this data. Run the newer image again, or see [Going back to an older version](#updates). |
| "APP_URL is http://, so its host must be a local address". | Use a local address ([Plain HTTP](#3-plain-http-on-the-home-network)), or an `https://` address with a proxy. |
| "TRUSTED_PROXIES=* is only for platform services". | With an `http://` `APP_URL`, leave `TRUSTED_PROXIES` empty, or list the proxy's own address. |
| Every page is refused, and the log says "Refused a request" with `"reason":"not-from-trusted-proxy"`. | The request came from an address not in `TRUSTED_PROXIES`. The log's `source` is that address. If it is your proxy, such as the Docker gateway for Tailscale Serve after a `docker compose down`, put it in `TRUSTED_PROXIES` and run `docker compose up -d`. |
| On plain HTTP, a page names another address. | Open exactly the `APP_URL` address. |
| Over HTTPS, every page answers 421. | The request's host is not `APP_URL`'s host. Open exactly the `APP_URL` address. If you do, your proxy rewrites the `Host`: with nginx, add `proxy_set_header Host $host;`; with the Compose file's Caddy, remove `--change-host-header` from its command. On a platform service, set `APP_URL` to the host the platform serves the app under. |
| The setup page refuses codes, or asks you to wait. | It allows 5 wrong codes per 15 minutes. Wait, and keep the app private until setup is done. |
| The setup link is lost. | `fft setup` prints it again until the first Member exists. While the app runs: `docker compose exec app fft-entrypoint --no-chown fft setup`. |
| No Member can sign in. | `docker compose exec app fft-entrypoint --no-chown fft reset-login member@example.com`. |
| Plaid Link does not finish on plain HTTP. | Use [Tailscale Serve](#1-tailscale-serve-preferred). |
| A System notice says a backup failed. | Check free space on the disk that holds `backups/`, and that the folder is writable. Then press "Back up now" in Settings, Backups and data. |
| "PUID must be a number above 0". | Set `PUID` and `PGID` to plain numbers above 0, such as `1000`. |
| A shell in the container is root. | Never use `docker compose exec app sh`. Use `docker compose exec app fft-entrypoint --no-chown <command>`. |

**Never delete `data/` to fix a problem.** It holds every Plaid token. Restore a backup instead.
