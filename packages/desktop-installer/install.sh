#!/usr/bin/env bash
# Infinite for macOS: the terminal entry point (`npx infinite-os@latest`).
#
# 2026-10-16: the Mac download sits behind sign-up. infinite.fast/download serves the signed app only to a
# browser that has just signed up on infinite.fast/get-started, so this installer no longer downloads a DMG.
# It opens the sign-up page in the default browser; the page starts the download right after sign-up.

set -euo pipefail
set -f

OPEN_BROWSER=true
case "${INFINITE_INSTALL_INTERACTIVE:-}" in
  1) INTERACTIVE_OUTPUT=true ;;
  0) INTERACTIVE_OUTPUT=false ;;
  *)
    if [ -t 0 ] && [ -t 1 ] && [ -t 2 ]; then
      INTERACTIVE_OUTPUT=true
    else
      INTERACTIVE_OUTPUT=false
    fi
    ;;
esac
# A script, CI job or pipe gets the link printed, never a browser window.
[ "$INTERACTIVE_OUTPUT" = true ] || OPEN_BROWSER=false

# The npm package version this installer ships in (packages/desktop-installer/package.json); the published
# artifact verifier pins the two together.
INSTALLER_VERSION="1.0.2"
APP_DIR="${INFINITE_APPLICATIONS_DIR:-/Applications}"

case "${INFINITE_INSTALL_SOURCE:-github}" in
  npm) UTM_SOURCE="npm" ;;
  *) UTM_SOURCE="github" ;;
esac
SIGNUP_URL="https://infinite.fast/get-started?cta=cli&utm_source=${UTM_SOURCE}&utm_medium=cli&utm_campaign=infinite_os_install"

usage() {
  cat <<'EOF'
Infinite for macOS installer

Usage: install.sh [--app-dir PATH] [--no-open] [-h|--help]

Opens infinite.fast/get-started in your browser. Sign up there and the Infinite Mac app
downloads right away.

Options:
  --app-dir PATH  Where Infinite.app is installed (default: /Applications)
  --no-open       Print the sign-up link instead of opening the browser
  -h, --help      Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app-dir) [ $# -ge 2 ] || { printf "✗ --app-dir requires a path\n" >&2; exit 2; }; APP_DIR="$2"; shift 2 ;;
    --no-open) OPEN_BROWSER=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf "✗ Unknown option: %s\n" "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -d "$APP_DIR/Infinite.app" ] && [ ! -L "$APP_DIR/Infinite.app" ]; then
  printf "Infinite is already installed at %s. It updates itself.\n" "$APP_DIR/Infinite.app"
  exit 0
fi

if [ "$OPEN_BROWSER" = true ] && [ "$(uname -s)" = "Darwin" ] && command -v open >/dev/null 2>&1; then
  printf "Sign up to download Infinite: opening infinite.fast/get-started…\n"
  if open "$SIGNUP_URL" >/dev/null 2>&1; then
    exit 0
  fi
fi
printf "Sign up to download Infinite: %s\n" "$SIGNUP_URL"
