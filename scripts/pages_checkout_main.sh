#!/usr/bin/env bash
# Check out the current origin/main once it contains the commit just pushed.
# A schedule job's github.sha is the pre-push commit. Deploying that tree
# drops the data commit. Deploying the branch tip, after this commit is on
# it, keeps a newer push that landed on top of the data commit.
# Usage: pages_checkout_main.sh <sha>
# PAGES_FETCH_DELAYS overrides the wait schedule (tests use "0").
set -euo pipefail

sha="${1:-}"
if [ -z "$sha" ]; then
  echo "missing commit sha" >&2
  exit 1
fi

ok=0
delays="${PAGES_FETCH_DELAYS:-0 2 4 8}"
for delay in $delays; do
  if [ "$delay" -ne 0 ]; then
    echo "waiting ${delay}s for $sha on origin/main"
    sleep "$delay"
  fi
  git fetch --depth=50 origin main
  if git merge-base --is-ancestor "$sha" origin/main; then
    ok=1
    break
  fi
done

if [ "$ok" -ne 1 ]; then
  echo "Commit $sha is not on origin/main" >&2
  exit 1
fi

git checkout --force origin/main
echo "Deploying $(git rev-parse HEAD)"
