#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TABLE="$ROOT/study-1/specs/tables/M0-A-001-payment-accept.json"
backup="$(mktemp)"
cp "$TABLE" "$backup"
cleanup() { cp "$backup" "$TABLE"; rm -f "$backup"; }
trap cleanup EXIT

python3 - <<'PY' "$TABLE"
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    table = json.load(fh)
table["input"]["captured_amount_minor"] = 10001
with open(path, "w", encoding="utf-8") as fh:
    json.dump(table, fh, indent=2)
    fh.write("\n")
PY

if (cd "$ROOT/study-1" && npm run golden-tables) >/tmp/golden-mutation.out 2>&1; then
  echo "FAIL: golden stayed green after mutating $TABLE" >&2
  cat /tmp/golden-mutation.out >&2
  exit 1
fi

echo "golden-mutation: ok (sabotaged table failed as required)"
