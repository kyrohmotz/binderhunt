#!/usr/bin/env bash
# Choose the Pages URL after up to three deploy-pages attempts.
# Exit 0 when any attempt's outcome is success. Exit 1 when none succeeded.
# OUTCOME1/2/3 are Actions step outcomes (success, failure, skipped).
# URL1/2/3 are the page_url outputs of those attempts.
# When GITHUB_OUTPUT is set, append page_url for the calling step.
set -euo pipefail

url=""
ok=0

consider() {
  local outcome="$1"
  local candidate="$2"
  if [ "$outcome" != "success" ]; then
    return 0
  fi
  ok=1
  if [ -z "$url" ] && [ -n "$candidate" ]; then
    url="$candidate"
  fi
}

consider "${OUTCOME1:-}" "${URL1:-}"
consider "${OUTCOME2:-}" "${URL2:-}"
consider "${OUTCOME3:-}" "${URL3:-}"

line="page_url=$url"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf '%s\n' "$line" >> "$GITHUB_OUTPUT"
else
  printf '%s\n' "$line"
fi

if [ "$ok" -eq 1 ]; then
  exit 0
fi

echo "Pages deploy failed after 3 attempts" >&2
exit 1
