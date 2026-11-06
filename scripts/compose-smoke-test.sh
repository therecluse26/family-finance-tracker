#!/usr/bin/env bash
# The image's smoke test with compose.yaml. It makes a self-hoster's folder from compose.yaml and
# .env.example with a local APP_URL, runs `fft setup`, and starts the app. It checks that the app
# runs as UID 1000, that PUID and PGID change it, and that the folders belong to that UID and are
# owner-only (files 0600, folders 0700, umask 077). It also checks that a symbolic link in data/
# hands nothing outside it to the app's user, and that the entrypoint refuses a PUID or PGID of 0,
# a non-number, or a number above 2147483647. The health check must run as the app's user.
# Usage: scripts/compose-smoke-test.sh <image>
# Needs docker with Compose, curl, and jq. It uses port 3000 on 127.0.0.1.
set -euo pipefail

image=$1
repo="$(cd "$(dirname "$0")/.." && pwd)"
folder=$(mktemp -d)
url=http://127.0.0.1:3000

fail() {
  echo "$1" >&2
  exit 1
}

# Runs a command as root in a throwaway container, with the folder at /folder. The app's files
# belong to its UID, which the runner's user may not be.
as_root() {
  docker run --rm --volume "$folder:/folder" --entrypoint "$1" "$image" "${@:2}"
}

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then docker compose logs app || true; fi
  docker compose down --volumes --timeout 15 >/dev/null 2>&1 || true
  as_root rm -rf /folder/data /folder/backups /folder/secrets || true
  rm -rf "$folder"
}

cd "$folder"
trap cleanup EXIT

cp "$repo/compose.yaml" .
sed "s|^APP_URL=$|APP_URL=$url|" "$repo/.env.example" >.env
# Compose reads compose.override.yaml by itself. It swaps in the image under test.
printf 'services:\n  app:\n    image: %s\n    pull_policy: never\n' "$image" >compose.override.yaml

echo "compose.yaml follows the spec"
# The caddy service shows only with its profile.
docker compose -f compose.yaml --profile caddy config --format json | jq --exit-status '
  .services.app.image == "ghcr.io/therecluse26/family-finance-tracker:1"
  and .services.app.restart == "unless-stopped"
  and .services.app.init == true
  and (.services.app.healthcheck.test | join(" ") | contains("/healthz"))
  and ([.services.app.volumes[] | "\(.source | sub(".*/"; "")):\(.target)"] | sort
    == ["backups:/backups", "data:/data", "secrets:/run/secrets"])
  and .services.caddy.profiles == ["caddy"]
  and (.services.caddy.image | test("^caddy:2@sha256:[0-9a-f]{64}$"))
' >/dev/null || fail "compose.yaml does not follow the spec"

echo "fft setup makes the Master key and prints the setup link"
# The output holds the setup code, which only grep reads.
docker compose run --rm app fft setup | grep --quiet "^  $url/setup#code=" ||
  fail "fft setup printed no setup link"

# Starts the app, waits for its health check, and checks that GET /healthz answers 200.
start() {
  docker compose up --detach --wait --wait-timeout 120
  curl --fail --silent --show-error --output /dev/null "$url/healthz"
}

# Checks the IDs and the capabilities of the app's process, and the owner of every file in the
# folders, symbolic links included.
check_owner() {
  local want="Umask: 0077
Uid: $1 $1 $1 $1
Gid: $2 $2 $2 $2
Groups:
CapEff: 0000000000000000"
  local got
  # The init process is the container's first process. The app is its one child.
  got=$(docker compose exec -T app sh -c 'set -- $(cat /proc/1/task/1/children); cat "/proc/$1/status"' |
    awk '$1 == "Umask:" || $1 == "Uid:" || $1 == "Gid:" || $1 == "Groups:" || $1 == "CapEff:" {
      $1 = $1; print }')
  [ "$got" = "$want" ] || fail "The app runs with these IDs, not $1:$2:"$'\n'"$got"
  # The health check runs with `docker exec`, as root. Its command, with the code swapped for
  # code that prints the IDs, must run as the app's user, with a HOME that user can read.
  local check
  mapfile -t check < <(docker compose config --format json |
    jq --raw-output '.services.app.healthcheck.test[1:-1][]')
  got=$(docker compose exec -T app "${check[@]}" "
    let home = 'home';
    try { require('node:fs').readdirSync(process.env.HOME); } catch { home = 'no-home'; }
    const ids = [process.getuid(), process.geteuid(), process.getgid(), process.getegid()];
    process.stdout.write([...ids, home].join(' '));")
  [ "$got" = "$1 $1 $2 $2 home" ] || fail "The health check runs as $got, not $1:$2 with a HOME"
  local others
  others=$(as_root find -P /folder/data /folder/backups /folder/secrets \
    \( ! -user "$1" -o ! -group "$2" \) -print)
  [ -z "$others" ] || fail "These files do not belong to $1:$2:"$'\n'"$others"
  as_root test -f /folder/data/app.db || fail "The app made no data/app.db"
  as_root test -f /folder/secrets/master.key || fail "fft setup made no secrets/master.key"
  # Owner-only: every file 0600 and every folder 0700, so no other user on the host reads them.
  # app.db's -wal and -shm files and jobs.db must be there, so the check covers them.
  for file in app.db-wal app.db-shm jobs.db; do
    as_root test -f "/folder/data/$file" || fail "The app made no data/$file"
  done
  local open
  open=$(as_root find -P /folder/data /folder/backups /folder/secrets \
    \( \( -type f ! -perm 600 \) -o \( -type d ! -perm 700 \) \) -exec stat -c '%a %n' {} +)
  [ -z "$open" ] || fail "These files are not owner-only:"$'\n'"$open"
}

echo "The app runs as UID 1000, and the folders belong to it"
start
check_owner 1000 1000

echo "PUID and PGID change the app's user, and the owner of the folders"
docker compose down --timeout 15
# Links to a folder and a file outside the mounts, owned by root. The entrypoint must change
# only the links, never what they point to.
as_root ln -s /app /folder/data/linked-folder
as_root ln -s /etc/passwd /folder/backups/linked-file
printf 'PUID=1001\nPGID=1002\n' >>.env
start
check_owner 1001 1002
outside=$(docker compose exec -T app find /app /etc/passwd ! -user 0 -print)
[ -z "$outside" ] || fail "A link handed these files to the app's user:"$'\n'"$outside"

echo "The entrypoint refuses a PUID or PGID of 0, a non-number, or a number above 2147483647"
# 4294967296 wraps to 0 in setpriv, and 4294967295 keeps root's ID.
for setting in PUID=0 PGID=0 PUID=00 PUID=abc PGID=-1 PUID=1000x PUID=4294967295 \
  PUID=4294967296 PGID=4294967296 PUID=2147483648 PUID=99999999999999999999; do
  if error=$(docker run --rm --env "$setting" "$image" true 2>&1); then
    fail "The entrypoint ran with $setting"
  fi
  grep --quiet "must be a number above 0" <<<"$error" || fail "$setting failed with: $error"
done

echo "Passed"
