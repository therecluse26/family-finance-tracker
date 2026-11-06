# Backup, restore, and data export

Backups exist for server recovery, not for long history. Every day at 3:00 AM, Household time, the app copies `app.db` into its own backup folder. It keeps the newest 7 regular backups and 3 safety copies. A restore is a command on the server, never a web page. Any Member can download the Household's data as one ZIP file.

## What a backup holds

- **Only `app.db`.**
- **Not `/data/jobs.db`.** It holds only waiting and finished jobs. At start, the app schedules missed work again, and jobs are safe to run twice.
- **Never the Master key.** The Household keeps it in a password manager, off the server.
- **Not the Compose file or `.env`.** Those are the self-hoster's own files. The setup guide tells them to keep a copy.

A backup is a plain file:

- After gunzip, a backup is a normal SQLite file. Any SQLite tool can open it. The app does not encrypt the file.
- The Master-key secrets stay encrypted inside it ([Members, login, and security](09-members-login-security.md#encryption-at-rest)). A leaked backup gives no access to any bank.
- A backup holds readable history: Transactions, Merchants, and Members' names and email addresses.
- It holds no full account numbers, because Plaid gives only the last 4 digits. Passwords are stored as hashes.
- Securing the backup folder is the self-hoster's job. The setup guide says that the folder holds readable history, and it advises an encrypted disk.

## How the app makes a backup

1. `VACUUM INTO` a temporary file in the backup folder. The app keeps running.
2. `PRAGMA integrity_check` on the copy.
3. Gzip it, then rename it to its final name.

- `VACUUM INTO` refuses to overwrite an existing file, hence the temporary name.
- If the check fails, the app deletes the temporary file. The backup counts as failed.
- At start, the app deletes any temporary files left behind.
- The file name holds the kind and the time, such as `app-20261102T080000Z-daily.db.gz`. The kinds are `daily`, `manual`, `migration`, and `restore`.
- Evidence: tested on 2026-10-31 in WAL mode. `VACUUM INTO` took 13 ms while another connection held an open write. The copy held every committed row, including rows still in the WAL file. It left out the uncommitted row.

## When backups run

| When | Kind | Rule |
|---|---|---|
| Daily at 3:00 AM, Household time | `daily` | If the server was off, the startup check runs the missed backup. |
| "Back up now" in settings | `manual` | Any Member, at any time. The page shows the result. |
| Before each migration | `migration` (safety copy) | If the safety copy fails, the app stops before it migrates and logs why. |
| During `fft restore` | `restore` (safety copy) | A copy of the database that the restore replaces. |

- Household time comes from the Household's ZIP code ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md)). Until the wizard's Household facts step sets it, the app uses UTC.
- **Startup check:** at start, the app runs a daily backup if the newest one is older than the most recent 3:00 AM.

## How many are kept

- The newest **7 regular backups** (`daily` or `manual`).
- The newest **3 safety copies** (`migration` or `restore`).
- After each successful backup, the app deletes older files by itself. It touches only files with its own names.
- Size: a test database with 16,000 Plaid-shaped Transactions, about 4 years for a busy Household, was 35.3 MB, or 3.2 MB gzipped. Real data compresses less. Expect 3 to 7 MB per file, and 30 to 70 MB for all 10.

## Where backups go

- Backups go to `/backups`, which has its own mount in the Compose file, outside `/data`.
- The self-hoster may point that mount at a NAS or a synced folder. The app uploads nothing itself.
- When `/backups` is not a mount of its own, the app writes backups to `/data/backups` instead. This covers platform services that give one volume ([Install and first-run setup](12-install-and-first-run.md#hosting-services)).
- Settings show the folder in use.

## When a backup fails

- The app retries a failed daily backup once, after 1 hour.
- If the retry fails, every Member gets a **System notice** by their chosen channels. A banner shows in the app until a backup succeeds.
- System notices skip the weekly Alert cap. They wait out quiet hours ([Anomalies and Alerts](06-anomalies-and-alerts.md)).
- Settings show the last successful backup, the number of files, and their total size.

## Restore

A restore is a command on the server, not a web page. Every Member has equal powers, so a web restore would let any Member overwrite all data.

The self-hoster:

1. Stops the app: `docker compose stop app`.
2. Runs `docker compose run --rm app fft restore <file>`.
3. Starts the app: `docker compose up -d`.

`fft restore <file>` does these things, in order:

1. It refuses to run while the app is running.
2. It finds the file. A bare file name means a file in the backup folder.
3. If no Master key exists, it makes a new one ([Members, login, and security](09-members-login-security.md#the-master-key)). It prints the new key once and tells the self-hoster to save it in a password manager.
4. It unzips the file and runs `PRAGMA integrity_check`. A failed check stops the restore.
5. It refuses a backup from a newer app version, meaning one that holds a migration this image does not have. An older backup is fine: migrations run at the next start.
6. It checks whether the Master key decrypts the backup's data key. If not, it lists the secrets that will be lost and asks the self-hoster to enter `yes`. Any other answer stops the restore.
7. It saves the current database, if one exists, to the backup folder as a `restore` safety copy.
8. It puts the backup in place and empties `jobs.db`.
9. Without a matching Master key, it deletes the unreadable secrets and removes every device from web push. It then encrypts a new data key with the current Master key.

After the restore:

- Sync continues from each Connection's saved cursor. Plaid's API spec says a cursor stays valid for at least 1 year.
- If Plaid rejects a cursor, sync restarts without duplicates ([Accounts and bank sync](02-accounts-and-bank-sync.md)).
- **What is lost:** Member changes made after the backup, such as hand-set Categories. Synced Transactions come back by themselves.
- A restore under a new web address deletes every passkey ([Members, login, and security](09-members-login-security.md#changing-app_url)).

### Without the Master key

The restore still brings back all history. Every Master-key secret is lost, with these results:

- **Connections.** Plaid's update mode needs the old access token. So every Connection becomes Broken, and Members connect each bank again as a new Plaid Item. History stays ([Accounts and bank sync](02-accounts-and-bank-sync.md#a-lost-master-key)).
- **Plaid Items.** Plaid's Trial plan allows 10 Items for life, and a removed Item keeps its slot.
  - Example: with all its banks connected, a Household with the example institutions has spent 6 Items. One went to a bank it later removed. Connecting its 5 banks again needs 5 more Items: 11 in all, 1 bank over the 10.
  - That bank stays unconnected until file import ships ([Accounts and bank sync](02-accounts-and-bank-sync.md#banks-the-app-cannot-connect)).
- **Keys.** Members enter the Plaid secret, the AI keys, and the SMTP password again.
- **Web push.** The app makes new VAPID keys. Each Member turns Alerts on again on each device.
- **Logins.** Every session ends and no TOTP code works ([Members, login, and security](09-members-login-security.md#login-secrets)). The self-hoster runs `fft reset-login` for one Member. That Member resets the others in the app.
- Every Member sees a System notice that lists what to set up again.

**A lost Master key with an intact server:** the self-hoster runs `fft restore` with the newest backup. The command makes a new Master key, as in step 3.

## Data export

Any Member can download one ZIP file from settings, at any time. The export asks for no code: the app asks for TOTP only at sign-in ([Members, login, and security](09-members-login-security.md#signing-in)).

**CSV files:** Transactions, Accounts, Budgets, Goals, and Category rules.

- The files are `transactions.csv`, `accounts.csv`, `budgets.csv`, `goals.csv`, and `category-rules.csv`.
- Each file is UTF-8, with a header row and comma separators.
- Dates are `YYYY-MM-DD`. Amounts are dollars with 2 decimals and no currency sign. Money out is negative; money in is positive.
- Each Transaction row has these columns:

| Column | Holds |
|---|---|
| `id` | The Transaction's ID. |
| `date` | The purchase date when the bank gives one, else the posted date ([Categorization](04-categorization.md)). |
| `account` | The Account's name. |
| `merchant` | The Merchant's clean name. |
| `description` | The bank's original description. |
| `amount` | The amount. |
| `category` | The Category. |
| `category_group` | The Category group. |
| `kind` | Spending, Income, Transfer, Saving, Refund, or Reimbursement. |
| `status` | Pending or posted. |
| `linked_ids` | The IDs of any linked Transactions, separated by `;`. |

- A split Transaction gives one row per part, each with its own Category.
- Transactions the provider removed are left out of the CSV. The JSON file holds them, with the reason.
- Each other CSV file has one row per record, with the fields the app shows for it.

**One JSON file** (`data.json`) holds all data except secrets. It includes Monthly reviews, Insight cards, Chat history, Proposals, and Alerts.

**Never included:**

- every Master-key secret ([Members, login, and security](09-members-login-security.md#encryption-at-rest));
- passkeys, TOTP secrets, backup codes, and password hashes;
- sessions, and open invite and reset links.

**Not encrypted.** The page says so before the download.

## Not in v1

These are listed in [Out of scope](13-out-of-scope.md):

- Turso. v1 supports only the local database file.
- Built-in upload of backups to cloud storage, such as S3.
- Export in other apps' formats (YNAB, Actual, QIF, OFX), and importing an export back. A restore uses backups, not exports.

## Sources

- [Backup, restore, and data export](https://github.com/therecluse26/family-finance-tracker-private/issues/22)
- [Install and first-run setup](https://github.com/therecluse26/family-finance-tracker-private/issues/21)
- [Stack and storage](https://github.com/therecluse26/family-finance-tracker-private/issues/12)
- [Encrypting a self-hosted database at rest](https://github.com/therecluse26/family-finance-tracker-private/issues/8)
- [Compare Plaid's Trial plan and SimpleFIN Bridge on real Accounts](https://github.com/therecluse26/family-finance-tracker-private/issues/10), for the Items already spent
- [Plaid `TransactionsSyncResponse`](https://docs.rs/crate/plaid/latest/source/src/model/transactions_sync_response.rs), generated from Plaid's API spec, for the cursor's 1-year validity
