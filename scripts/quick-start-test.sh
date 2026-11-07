#!/usr/bin/env bash
# Runs the README's quick start against an image, as a stranger would, and checks that `fft setup`
# prints a setup link and that GET /healthz answers 200. The commands come from the README's
# "## Quick start" block, word for word. Only two things change:
# - curl copies compose.yaml and .env.example from this checkout, so the test fetches nothing.
#   The README must fetch only those two files, from the tag of the version in package.json.
# - A Compose override swaps in the image under test.
# Then, on that install, it runs the first-run wizard through the API the setup pages call, with
# the Banks step skipped, until the dashboard opens. No bank is connected and Plaid is never called.
# Last comes the restore drill from the setup guide: "Back up now", `docker compose stop app`,
# `fft restore <file>`, `docker compose up -d`, and the Household facts saved before the backup
# come back. The setup code, the TOTP secret, the password, and the Master key are made for this
# run, and the test never prints them.
# Usage: scripts/quick-start-test.sh <image> [platform]
# The platform, such as linux/arm64, runs an image built for another one through emulation.
# Needs docker with Compose, curl, jq, and openssl. It uses port 3000 on 127.0.0.1.
set -euo pipefail

image=$1
platform=${2-}
repo="$(cd "$(dirname "$0")/.." && pwd)"
work=$(mktemp -d)
url=http://localhost:3000

fail() {
  echo "$1" >&2
  exit 1
}

# The fenced sh block under "## Quick start".
block=$(awk '
  /^## / { in_section = ($0 == "## Quick start") }
  in_section && !in_block && /^```sh$/ { in_block = 1; next }
  in_block && /^```$/ { exit }
  in_block { print }
' "$repo/README.md")
[ -n "$block" ] || fail "README.md has no sh block under ## Quick start"

# The quick start's folder, which its first line makes.
folder="$work/family-finance-tracker"

cleanup() {
  status=$?
  if [ -f "$folder/compose.yaml" ]; then
    (
      cd "$folder"
      if [ "$status" -ne 0 ]; then docker compose logs app || true; fi
      docker compose down --volumes --timeout 15 >/dev/null 2>&1 || true
    )
    as_root rm -rf /folder/data /folder/backups /folder/secrets || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# Runs a command as root in a throwaway container, with the folder at /folder. The app's files
# belong to its UID, which the runner's user may not be.
as_root() {
  docker run --rm ${platform:+--platform "$platform"} --volume "$folder:/folder" \
    --entrypoint "$1" "$image" "${@:2}"
}

# The README's raw file addresses, mapped to this checkout. Any other address fails the test.
version=$(jq --raw-output .version "$repo/package.json")
raw=https://raw.githubusercontent.com/therecluse26/family-finance-tracker/v$version/
curl() {
  local arg
  for arg in "$@"; do
    case $arg in
      -fsSL | -O) ;;
      "${raw}compose.yaml" | "${raw}.env.example") cp "$repo/${arg#"$raw"}" . ;;
      *)
        echo "The quick start runs curl with \"$arg\", which this test does not know." >&2
        return 1
        ;;
    esac
  done
}
export -f curl
export repo raw

{
  printf 'services:\n  app:\n    image: %s\n    pull_policy: never\n' "$image"
  if [ -n "$platform" ]; then printf '    platform: %s\n' "$platform"; fi
} >"$work/override.yaml"
# Compose reads both files. The project name keeps the test apart from any real install.
export COMPOSE_FILE="compose.yaml:$work/override.yaml"
export COMPOSE_PROJECT_NAME=fft-quick-start-test

# The last lines of a command's output, without the setup link or any 64-hex-digit run, such as a
# Master key that `fft setup` or `fft restore` prints, so a failure never shows one.
redacted_tail() {
  grep -Ev 'setup#code=|[0-9A-Fa-f]{64}' "$1" | tail -20 || true
}

echo "Running the README quick start"
# The output holds the setup code, which only grep and sed read.
(cd "$work" && bash -euo pipefail -c "$block") >"$work/output.txt" ||
  fail "The quick start failed: $(redacted_tail "$work/output.txt")"

echo "fft setup prints the setup link"
grep --quiet "^  $url/setup#code=[0-9A-Z]\{4\}-[0-9A-Z]\{4\}-[0-9A-Z]\{4\}$" "$work/output.txt" ||
  fail "fft setup printed no setup link for $url"
setup_code=$(sed -n "s|^  $url/setup#code=||p" "$work/output.txt")

# Waits until GET /healthz answers 200. An app under emulation starts slowly.
wait_for_app() {
  for _ in $(seq 1 300); do
    if command curl --fail --silent --output /dev/null "$url/healthz"; then return 0; fi
    sleep 1
  done
  fail "GET /healthz did not answer 200"
}

echo "GET /healthz answers 200, and the setup page opens"
wait_for_app
command curl --fail --silent --show-error --output /dev/null --write-out '%{content_type}\n' \
  "$url/setup" | grep --quiet '^text/html' || fail "The setup page did not open"

# Sends one API request as the app's own pages do, with its Origin and the session cookie, and
# prints the answer. A status that is not 2xx fails the test, with the answer's error only. The
# JSON body goes to curl on stdin, never as an argument, so no throwaway secret shows in the
# runner's process list. Bodies are built with bash's own printf for the same reason.
jar="$work/cookies.txt"
api() {
  local args=(--silent --show-error --cookie "$jar" --cookie-jar "$jar" --request "$1"
    --header "Origin: $url" --output "$work/answer.json" --write-out '%{http_code}')
  local status
  if [ $# -ge 3 ]; then
    args+=(--header "Content-Type: application/json" --data-binary @-)
    status=$(command curl "${args[@]}" "$url$2" <<<"$3") || fail "$1 $2 failed"
  else
    status=$(command curl "${args[@]}" "$url$2") || fail "$1 $2 failed"
  fi
  if [[ $status != 2* ]]; then
    fail "$1 $2 answered $status: $(jq --raw-output '.error // .message // empty' "$work/answer.json" 2>/dev/null || true)"
  fi
  cat "$work/answer.json"
}

cd "$folder"

echo "The wizard makes the first Member, with password and TOTP"
email=member@example.com
password=$(openssl rand -hex 16)
# The setup code is 3 groups of 4 letters and digits, as the grep above checked, and the password
# is hex, so neither needs JSON escaping.
printf -v body '{"setupCode":"%s","email":"%s"}' "$setup_code" "$email"
totp_uri=$(api POST /api/auth/first-member/new-totp "$body" | jq --raw-output .totpURI)
# The authenticator app's code: RFC 6238 with SHA-1, 6 digits, and 30 seconds, from the secret in
# the otpauth:// address. The app's own Node.js works it out, and reads the address on stdin.
totp_code=$(docker compose exec -T app node -e '
  const uri = require("node:fs").readFileSync(0, "utf8").trim();
  const secret = new URL(uri).searchParams.get("secret").replace(/=+$/, "").toUpperCase();
  const bits = [...secret]
    .map((letter) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(letter).toString(2).padStart(5, "0"))
    .join("");
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hash = require("node:crypto").createHmac("sha1", key).update(counter).digest();
  const at = hash[hash.length - 1] & 15;
  process.stdout.write(String((hash.readUInt32BE(at) & 0x7fffffff) % 1e6).padStart(6, "0"));
' <<<"$totp_uri")
[[ $totp_code =~ ^[0-9]{6}$ ]] || fail "The TOTP code is not 6 digits"
printf -v body '{"setupCode":"%s","name":"Test Member","email":"%s","password":"%s","totpCode":"%s"}' \
  "$setup_code" "$email" "$password" "$totp_code"
api POST /api/auth/first-member/create "$body" >/dev/null

echo "The wizard shows the Master key once, and takes it back"
master_key=$(api GET /api/setup/master-key | jq --raw-output .masterKey)
[[ $master_key =~ ^[0-9A-Fa-f]{64}$ ]] || fail "The wizard showed no Master key"
printf -v body '{"masterKey":"%s"}' "$master_key"
api POST /api/setup/master-key "$body" >/dev/null

echo "The wizard saves the Household facts"
facts='{"zipCode":"06103","ages":[41,39,9],"rentOrOwn":"own"}'
api PUT /api/household "$facts" >/dev/null

echo "The wizard skips the Banks step and the other optional steps, then opens the dashboard"
for step in banks ai alerts invite%20members; do
  api POST "/api/setup/steps/$step/skip" '{}' >/dev/null
done
api POST /api/setup/finish '{}' >/dev/null
# The web app opens the dashboard, not the wizard, once both say so.
api GET /api/setup | jq --exit-status '.wizard == false' >/dev/null ||
  fail "The app still opens the wizard"
api GET /api/setup/progress |
  jq --exit-status '.progress.next == null and .progress.steps.banks == "skipped" and
    .progress.finishSetup[0] == "banks" and .progress.connections == 0' >/dev/null ||
  fail "The wizard did not end at the dashboard with the Banks step skipped"
command curl --fail --silent --show-error --output /dev/null --write-out '%{content_type}\n' \
  "$url/" | grep --quiet '^text/html' || fail "The dashboard page did not open"

# The facts as GET /api/household gives them, without the time they were saved.
saved_facts() {
  api GET /api/household | jq --compact-output '.facts | {zipCode, ages, rentOrOwn}'
}
[ "$(saved_facts)" = "$facts" ] || fail "The Household facts were not saved"

echo "Back up now writes a manual backup"
backup=$(api POST /api/backups/now '{}' | jq --raw-output .backup.file)
[[ $backup =~ ^app-[0-9]{8}T[0-9]{6}Z-manual\.db\.gz$ ]] || fail "Back up now wrote \"$backup\""
as_root test -f "/folder/backups/$backup" || fail "backups/ holds no $backup"

echo "A change after the backup"
api PUT /api/household '{"zipCode":"06103","ages":[41],"rentOrOwn":"rent"}' >/dev/null
[ "$(saved_facts)" != "$facts" ] || fail "The Household facts did not change"

echo "docker compose stop app, fft restore, docker compose up -d"
docker compose stop app
docker compose run --rm app fft restore "$backup" >"$work/restore.txt" 2>&1 ||
  fail "fft restore failed: $(redacted_tail "$work/restore.txt")"
docker compose up -d
wait_for_app

echo "The data comes back: the Household facts are the ones from before the backup"
[ "$(saved_facts)" = "$facts" ] || fail "The restore did not bring the Household facts back"
api GET /api/setup | jq --exit-status '.wizard == false' >/dev/null ||
  fail "The restored app opens the wizard"

echo "Passed"
