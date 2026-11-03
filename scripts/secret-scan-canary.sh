#!/usr/bin/env bash
# Proves that scripts/secret-scan.sh, with this repo's .gitleaks.toml, still catches each kind
# of secret that matters here: in files that .gitattributes or a NUL byte marks as binary, in
# paths that gitleaks' default config skips, and in commit messages, file names, and author
# names. Also proves that it fails when git log fails, and that it refuses a .gitleaksignore
# file and any file that gitleaks skips. Every value is random and made up here.
# Usage: scripts/secret-scan-canary.sh <gitleaks binary>
set -euo pipefail

gitleaks=$1
scan="$(cd "$(dirname "$0")" && pwd)/secret-scan.sh"
canary=$(mktemp -d)
trap 'rm -rf "$canary"' EXIT

# Random characters from a tr set, such as rand 'A-Z2-7' 16.
rand() {
  local chars
  chars=$(openssl rand -base64 600 | LC_ALL=C tr -dc "$1")
  printf '%s' "${chars:0:$2}"
}
uuid() {
  local hex
  hex=$(openssl rand -hex 16)
  printf '%s' "${hex:0:8}-${hex:8:4}-${hex:12:4}-${hex:16:4}-${hex:20:12}"
}
github_token() { printf 'ghp_%s' "$(rand 'A-Za-z0-9' 36)"; }

# Commits everything in a repo folder: commit_all <folder> <message> [author name]
commit_all() {
  git -C "$1" add --all --force
  git -C "$1" -c user.name="${3:-canary}" -c user.email=canary@example.invalid \
    commit --quiet --message "$2"
}

# Scans a repo folder and checks the exit code: expect_exit <code> <folder> <what it holds>
expect_exit() {
  local status=0
  "$scan" "$gitleaks" "$2" > "$2.log" 2>&1 || status=$?
  if [ "$status" -ne "$1" ]; then
    cat "$2.log"
    echo "The secret scan exited $status on $3. It should exit $1." >&2
    exit 1
  fi
}

# One repo with a secret of each kind, each in its own file, checked by rule ID.
repo="$canary/repo"
git init --quiet "$repo"
printf '*.ts -diff\n' > "$repo/.gitattributes"
printf 'export const token = "%s";\n' "$(github_token)" > "$repo/hidden.ts"
{
  printf 'AWS_ACCESS_KEY_ID=AKIA%s\n' "$(rand 'A-Z2-7' 16)"
  printf '\0'
} > "$repo/binary.txt"
{
  printf 'ANTHROPIC_API_KEY=sk-ant-api03-%sAA\n' "$(rand 'A-Za-z0-9' 93)"
  printf 'OPENAI_API_KEY=sk-proj-%sT3BlbkFJ%s\n' "$(rand 'A-Za-z0-9' 74)" "$(rand 'A-Za-z0-9' 74)"
} > "$repo/keys.env"
printf -- '-----BEGIN %s-----\n%s\n%s\n-----END %s-----\n' \
  "PRIVATE KEY" "$(rand 'A-Za-z0-9+/' 64)" "$(rand 'A-Za-z0-9+/' 64)" "PRIVATE KEY" \
  > "$repo/server.pem"
printf '{"chase": "access-production-%s"}\n' "$(uuid)" > "$repo/banks.json"
printf 'LINK_TOKEN=link-sandbox-%s\n' "$(uuid)" > "$repo/link.txt"
printf 'old = token_access-production-%s_old\n' "$(uuid)" > "$repo/underscored.txt"
printf 'x9public-development-%s7a\n' "$(uuid)" > "$repo/wordy.txt"
commit_all "$repo" canary

status=0
"$scan" "$gitleaks" "$repo" "$canary/report.json" > "$canary/scan.log" 2>&1 || status=$?
if [ "$status" -ne 1 ]; then
  cat "$canary/scan.log"
  echo "The secret scan exited $status on the planted secrets. It should exit 1." >&2
  exit 1
fi
found=$(jq -r '.[] | "\(.RuleID) \(.File)"' "$canary/report.json" | sort -u)
missed=0
for expected in \
  "github-pat hidden.ts" \
  "aws-access-token binary.txt" \
  "anthropic-api-key keys.env" \
  "openai-api-key keys.env" \
  "private-key server.pem" \
  "plaid-token-any-context banks.json" \
  "plaid-token-any-context link.txt" \
  "plaid-token-any-context underscored.txt" \
  "plaid-token-any-context wordy.txt"; do
  if grep --quiet --line-regexp --fixed-strings "$expected" <<< "$found"; then
    echo "Caught: $expected"
  else
    echo "Missed: $expected" >&2
    missed=1
  fi
done
[ "$missed" -eq 0 ]

# Paths that gitleaks' default config skips. Each gets its own repo, so each must be caught.
n=0
for path in \
  src/web/logo.svg \
  pnpm-lock.yaml \
  package-lock.json \
  src/server/bootstrap.js \
  src/server/gitleaks.toml.ts \
  docs/gitleaks.toml.md \
  .gitleaks.toml \
  src/server/env/lib/config.ts \
  src/algo.sum \
  vendor/github.com/acme/x/config.go \
  assets/model.gltf \
  fixtures/data.bin \
  src/web/public/icon.png \
  src/web/fonts/inter.woff2; do
  n=$((n + 1))
  dir="$canary/path-$n"
  mkdir -p "$dir/$(dirname "$path")"
  git init --quiet "$dir"
  printf 'token = "%s"\n' "$(github_token)" > "$dir/$path"
  commit_all "$dir" "Add a file"
  expect_exit 1 "$dir" "a secret in $path"
  echo "Caught: a secret in $path"
done

# A secret only in a commit message, only in a file name, or only in an author name.
for place in "a commit message" "a file name" "an author name"; do
  dir="$canary/${place// /-}"
  git init --quiet "$dir"
  message="Add notes"
  author=canary
  case $place in
    "a commit message") message="Use $(github_token) for now" && touch "$dir/notes.txt" ;;
    "a file name") touch "$dir/access-production-$(uuid).txt" ;;
    "an author name") author=$(github_token) && touch "$dir/notes.txt" ;;
  esac
  commit_all "$dir" "$message" "$author"
  expect_exit 1 "$dir" "a secret in $place"
  echo "Caught: a secret in $place"
done

# A commit whose file git can no longer read. gitleaks git exits 0 when its git log fails,
# so the scan itself must notice.
dir="$canary/broken"
git init --quiet "$dir"
printf 'token = "%s"\n' "$(github_token)" > "$dir/gone.txt"
commit_all "$dir" "Add a file"
blob=$(git -C "$dir" rev-parse HEAD:gone.txt)
rm -f "$dir/.git/objects/${blob:0:2}/${blob:2}" "$dir/gone.txt"
expect_exit 2 "$dir" "a commit that git log cannot read"
echo "Refused: a git log that fails"

# Files that gitleaks skips: one still tracked, and one only in an earlier commit.
dir="$canary/skipped"
git init --quiet "$dir"
mkdir -p "$dir/node_modules/x"
touch "$dir/node_modules/x/index.js" "$dir/Statement.PDF"
commit_all "$dir" "Add files"
git -C "$dir" rm --quiet -r node_modules
commit_all "$dir" "Remove"
expect_exit 4 "$dir" "files that gitleaks skips"
for file in node_modules/x/index.js Statement.PDF; do
  if ! grep --quiet --line-regexp --fixed-strings "$file" "$dir.log"; then
    cat "$dir.log"
    echo "The secret scan did not name $file." >&2
    exit 1
  fi
done
echo "Refused: files that gitleaks skips"

touch "$repo/.gitleaksignore"
expect_exit 3 "$repo" "a repo with a .gitleaksignore"
echo "Refused: .gitleaksignore"
