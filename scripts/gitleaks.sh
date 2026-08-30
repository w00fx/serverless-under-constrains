#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/tools/bin/gitleaks"

if [[ ! -x "$BIN" ]]; then
  bash "$ROOT/scripts/bootstrap.sh"
fi

exec "$BIN" detect --source "$ROOT" --config "$ROOT/.gitleaks.toml" --redact --no-banner --verbose
