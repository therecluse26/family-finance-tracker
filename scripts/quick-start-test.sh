#!/usr/bin/env bash
# Runs the README's quick start against an image, as a stranger would, and checks that `fft setup`
# prints a setup link and that GET /healthz answers 200. The commands come from the README's
# "## Quick start" block, word for word. Only two things change:
# - curl copies compose.yaml and .env.example from this checkout, so the test fetches nothing.
#   The README must fetch only those two files.
# - A Compose override swaps in the image under test.
# Usage: scripts/quick-start-test.sh <image>
# Needs docker with Compose, and curl. It uses port 3000 on 127.0.0.1.
set -euo pipefail

image=$1
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
    # The app's files belong to its UID, which the runner's user may not be.
    docker run --rm --volume "$folder:/folder" --entrypoint rm "$image" \
      -rf /folder/data /folder/backups /folder/secrets || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# The README's raw file addresses, mapped to this checkout. Any other address fails the test.
raw=https://raw.githubusercontent.com/therecluse26/family-finance-tracker/main/
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

printf 'services:\n  app:\n    image: %s\n    pull_policy: never\n' "$image" >"$work/override.yaml"
# Compose reads both files. The project name keeps the test apart from any real install.
export COMPOSE_FILE="compose.yaml:$work/override.yaml"
export COMPOSE_PROJECT_NAME=fft-quick-start-test

echo "Running the README quick start"
# The output holds the setup code, which only grep reads.
(cd "$work" && bash -euo pipefail -c "$block") >"$work/output.txt" ||
  fail "The quick start failed: $(grep -v 'setup#code=' "$work/output.txt" | tail -20)"

echo "fft setup prints the setup link"
grep --quiet "^  $url/setup#code=[0-9A-Z]\{4\}-[0-9A-Z]\{4\}-[0-9A-Z]\{4\}$" "$work/output.txt" ||
  fail "fft setup printed no setup link for $url"

echo "GET /healthz answers 200, and the setup page opens"
for _ in $(seq 1 120); do
  if command curl --fail --silent --output /dev/null "$url/healthz"; then break; fi
  sleep 1
done
status=$(command curl --silent --output /dev/null --write-out '%{http_code}' "$url/healthz" || true)
[ "$status" = 200 ] || fail "GET /healthz answered $status"
command curl --fail --silent --show-error --output /dev/null --write-out '%{content_type}\n' \
  "$url/setup" | grep --quiet '^text/html' || fail "The setup page did not open"

echo "Passed"
