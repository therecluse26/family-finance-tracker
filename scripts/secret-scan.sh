#!/usr/bin/env bash
# The CI secret scan: every commit reachable from HEAD, with its file names, author, and
# message, and the files as they stand, including inside archives.
# Usage: scripts/secret-scan.sh <gitleaks binary> [repo folder] [JSON report of the commit scan]
# Exits 1 when gitleaks finds a secret, 2 when git log fails, 3 when a .gitleaksignore file
# is present, and 4 when git holds a file that gitleaks skips.
set -euo pipefail

gitleaks=$1
repo=${2:-.}
report=${3:-}
config="$(cd "$(dirname "$0")/.." && pwd)/.gitleaks.toml"

# gitleaks reads .gitleaksignore from the scanned folder and the current one, and a reviewer
# cannot tell what a fingerprint in it hides. Suppressions belong in .gitleaks.toml.
ignores=$(find "$repo" -name .gitleaksignore -not -path '*/.git/*' -not -path '*/node_modules/*')
if [ -e .gitleaksignore ] || [ -L .gitleaksignore ]; then
  ignores="${ignores:+$ignores$'\n'}$PWD/.gitleaksignore"
fi
if [ -n "$ignores" ]; then
  echo "Remove .gitleaksignore, and put any suppression in .gitleaks.toml:" >&2
  echo "$ignores" >&2
  exit 3
fi

# gitleaks' default config skips node_modules folders and these document types, in any
# letter case. git log --text cannot show the text inside these document types either. So
# git may not hold them, now or in any commit.
tracked=$(git -C "$repo" ls-files -z | tr '\0' '\n')
history=$(git -C "$repo" log -m -z --format= --name-only HEAD | tr '\0' '\n')
skipped=$(printf '%s\n%s\n' "$tracked" "$history" |
  grep -iE '(^|/)node_modules(/|$)|\.(pdf|docx?|xlsx?)$' | sort -u || true)
if [ -n "$skipped" ]; then
  echo "gitleaks does not scan these files, so remove them from git, and from its history:" >&2
  echo "$skipped" >&2
  exit 4
fi

flags=(--no-banner --redact --verbose --ignore-gitleaks-allow --config "$config")
report_flags=()
if [ -n "$report" ]; then report_flags=(--report-format json --report-path "$report"); fi

status=0
# --text makes git print every file, including one that .gitattributes or a NUL byte marks
# as binary, which git log -p would otherwise leave out.
"$gitleaks" git "${flags[@]}" "${report_flags[@]}" --log-opts="--text HEAD" "$repo" || status=1
"$gitleaks" dir "${flags[@]}" --max-archive-depth 2 "$repo" || status=1

# gitleaks' default config skips many paths in the scans above, such as SVG files and
# lockfiles. Text on stdin has no path, so this pass sees every change in every commit, with
# its file names, author, committer, and message. gitleaks git exits 0 when its own git log
# fails, so this pass also checks that git log ran to the end.
set +e
git -C "$repo" -c core.quotePath=false log -p --text -U0 -m \
  --format='%an%n%ae%n%cn%n%ce%n%B' HEAD | "$gitleaks" stdin "${flags[@]}"
codes=("${PIPESTATUS[@]}")
set -e
if [ "${codes[0]}" -ne 0 ]; then
  echo "git log failed (exit ${codes[0]}), so the scan did not see every commit." >&2
  exit 2
fi
if [ "${codes[1]}" -ne 0 ]; then status=1; fi
exit "$status"
