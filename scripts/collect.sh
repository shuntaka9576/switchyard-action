#!/usr/bin/env bash
# Incrementally fetch switchyard-stats-* artifacts from one or more
# repositories into ./collected/ (override with COLLECT_DIR).
#
#   ./scripts/collect.sh owner/repo [owner/repo ...]
#
# Requires: gh (authenticated), unzip, jq.
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "usage: $0 owner/repo [owner/repo ...]" >&2
  exit 2
fi

OUT_DIR="${COLLECT_DIR:-collected}"
mkdir -p "$OUT_DIR"

for repo in "$@"; do
  echo "== $repo"
  gh api "repos/$repo/actions/artifacts?per_page=100" --paginate \
    --jq '.artifacts[] | select(.name | startswith("switchyard-stats-")) | select(.expired | not) | [.id, .name] | @tsv' |
    while IFS=$'\t' read -r id name; do
      dest="$OUT_DIR/${repo//\//_}/$name"
      if [ -d "$dest" ]; then
        continue
      fi
      mkdir -p "$dest"
      gh api "repos/$repo/actions/artifacts/$id/zip" > "$dest/artifact.zip"
      unzip -oq "$dest/artifact.zip" -d "$dest"
      rm -f "$dest/artifact.zip"
      echo "fetched $name"
    done
done

echo "done. aggregate with: ./scripts/aggregate.py"
