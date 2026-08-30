#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${GITLEAKS_VERSION:-8.30.1}"
BIN_DIR="$ROOT/tools/bin"
DEST="$BIN_DIR/gitleaks"

if [[ ! -d "$ROOT/study-1/node_modules" ]]; then
  if command -v npm >/dev/null 2>&1; then
    (cd "$ROOT/study-1" && npm ci)
  else
    echo "skip npm ci (npm not on PATH)"
  fi
else
  echo "study-1/node_modules already present"
fi

if [[ -x "$DEST" ]]; then
  echo "gitleaks already at $DEST"
  "$DEST" version
  exit 0
fi

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os-$arch" in
  darwin-arm64) asset="gitleaks_${VERSION}_darwin_arm64.tar.gz" ;;
  darwin-x86_64) asset="gitleaks_${VERSION}_darwin_x64.tar.gz" ;;
  linux-x86_64|linux-amd64) asset="gitleaks_${VERSION}_linux_x64.tar.gz" ;;
  linux-arm64|linux-aarch64) asset="gitleaks_${VERSION}_linux_arm64.tar.gz" ;;
  *)
    echo "NAMED BLOCKER: no gitleaks asset for $os-$arch" >&2
    exit 1
    ;;
esac

mkdir -p "$BIN_DIR"
url="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${asset}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "downloading $url"
curl -fsSL "$url" | tar -xz -C "$tmp" gitleaks
install -m 0755 "$tmp/gitleaks" "$DEST"
"$DEST" version
