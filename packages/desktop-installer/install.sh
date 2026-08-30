#!/usr/bin/env bash
# Install Infinite for macOS from the same signed Desktop release as infinite.fast/download.
#
#   curl -fsSL https://raw.githubusercontent.com/Infinite-Labs-AI/infinite-os/main/scripts/install.sh | bash
#
# Infinite is a macOS-only app. The Desktop bundle includes the local engine, embedded database,
# and `infinite` CLI; this installer never installs Docker, Node, or a second engine checkout.

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
log_info() { printf "${CYAN}→${NC} %s\n" "$1"; }
log_success() { printf "${GREEN}✓${NC} %s\n" "$1"; }
log_warn() { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
log_error() { printf "${RED}✗${NC} %s\n" "$1" >&2; }

DOWNLOAD_URL="https://infinite.fast/download"
INSTALLER_USER_AGENT="Infinite-Installer/1.0.0"
EXPECTED_BUNDLE_ID="inc.ultima.infiniteos-desktop"
EXPECTED_TEAM_ID="4659K3678P"
APP_DIR="${INFINITE_APPLICATIONS_DIR:-/Applications}"
OPEN_APP=true
AUTO_OPEN_BLOCKED=false

case "${INFINITE_INSTALL_SOURCE:-github}" in
  npm)
    DOWNLOAD_REQUEST_URL="${DOWNLOAD_URL}?utm_source=npm&utm_medium=cli&utm_campaign=infinite_os_install"
    ;;
  *)
    DOWNLOAD_REQUEST_URL="${DOWNLOAD_URL}?utm_source=github&utm_medium=cli&utm_campaign=infinite_os_install"
    ;;
esac

usage() {
  cat <<'EOF'
Infinite for macOS installer

Usage: install.sh [--app-dir PATH] [--no-open] [-h|--help]

Downloads the signed and notarized Infinite Desktop app from infinite.fast/download,
installs Infinite.app, and opens it. Infinite Desktop includes the local engine and CLI.

Options:
  --app-dir PATH  Install directory (default: /Applications)
  --no-open       Install without launching Infinite
  -h, --help      Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app-dir)
      [ $# -ge 2 ] || { log_error "--app-dir requires a path"; exit 2; }
      APP_DIR="$2"
      shift 2
      ;;
    --no-open)
      OPEN_APP=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log_error "Unknown option: $1"
      usage >&2
      exit 2
      ;;
  esac
done

printf "\n${BOLD}${CYAN}Infinite for macOS installer${NC}\n\n"

OS="$(uname -s)"
if [ "$OS" != "Darwin" ]; then
  log_error "Infinite is a macOS-only app. This installer does not support $OS."
  exit 1
fi

ARCH="$(uname -m)"
APPLE_SILICON=false
if [ "$ARCH" = "arm64" ]; then
  APPLE_SILICON=true
elif [ "$ARCH" = "x86_64" ]; then
  TRANSLATED="$(sysctl -in sysctl.proc_translated 2>/dev/null || true)"
  ARM64_CAPABLE="$(sysctl -in hw.optional.arm64 2>/dev/null || true)"
  if [ "$TRANSLATED" = "1" ] && [ "$ARM64_CAPABLE" = "1" ]; then
    APPLE_SILICON=true
    log_info "Detected Apple silicon through Rosetta."
  fi
fi
if [ "$APPLE_SILICON" != true ]; then
  log_error "Infinite requires an Apple silicon Mac; found $ARCH."
  exit 1
fi

MACOS_VERSION="$(sw_vers -productVersion)"
MACOS_MAJOR="${MACOS_VERSION%%.*}"
case "$MACOS_MAJOR" in
  ''|*[!0-9]*)
    log_error "Could not determine the macOS version from '$MACOS_VERSION'."
    exit 1
    ;;
esac
if [ "$MACOS_MAJOR" -lt 12 ]; then
  log_error "Infinite requires macOS 12 or newer; found macOS $MACOS_VERSION."
  exit 1
fi

for command_name in curl hdiutil codesign spctl ditto sw_vers; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    log_error "Required macOS command not found: $command_name"
    exit 1
  fi
done
if [ "$OPEN_APP" = true ] && ! command -v open >/dev/null 2>&1; then
  log_error "Required macOS command not found: open"
  exit 1
fi

TARGET_APP="$APP_DIR/Infinite.app"

verify_infinite_app() {
  app_path="$1"
  [ -d "$app_path" ] || return 1

  codesign --verify --deep --strict "$app_path" >/dev/null 2>&1 || return 1
  signature_details="$(codesign -dv --verbose=4 "$app_path" 2>&1)" || return 1
  bundle_id="$(printf '%s\n' "$signature_details" | sed -n 's/^Identifier=//p' | head -n 1)"
  team_id="$(printf '%s\n' "$signature_details" | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
  [ "$bundle_id" = "$EXPECTED_BUNDLE_ID" ] || return 1
  [ "$team_id" = "$EXPECTED_TEAM_ID" ] || return 1
  spctl --assess --type execute "$app_path" >/dev/null 2>&1 || return 1
}

migrate_legacy_launcher() {
  launcher="$HOME/.local/bin/infinite"
  legacy_marker='# Infinite launcher shim — installed by scripts/install.sh.'

  [ -e "$launcher" ] || return 0
  if [ -f "$launcher" ] && [ ! -L "$launcher" ] \
    && grep -Fq "$legacy_marker" "$launcher" \
    && grep -Eq '^exec ".*/\.infinite/app/infinite" "\$@"$' "$launcher"; then
    backup="${launcher}.legacy-installer"
    suffix=1
    while [ -e "$backup" ]; do
      backup="${launcher}.legacy-installer.${suffix}"
      suffix=$((suffix + 1))
    done
    mv "$launcher" "$backup"
    log_success "Moved the legacy installer-owned CLI wrapper to $backup"
    log_info "Infinite Desktop will install the current CLI when it opens."
  else
    log_warn "An existing 'infinite' command is not owned by the legacy installer; preserving it."
    log_warn "Infinite was not opened automatically because the current Desktop release could replace that command on launch."
    AUTO_OPEN_BLOCKED=true
  fi
}

launch_if_requested() {
  if [ "$OPEN_APP" = true ] && [ "$AUTO_OPEN_BLOCKED" != true ]; then
    log_info "Opening Infinite…"
    open "$TARGET_APP"
  fi
}

if [ -e "$TARGET_APP" ]; then
  if verify_infinite_app "$TARGET_APP"; then
    log_success "A signed, notarized Infinite app is already installed at $TARGET_APP"
    migrate_legacy_launcher
    launch_if_requested
    exit 0
  fi
  log_error "$TARGET_APP already exists but does not match Infinite's verified production signature."
  log_error "It was left untouched. Move or remove it yourself before retrying."
  exit 1
fi

mkdir -p "$APP_DIR"
if [ ! -w "$APP_DIR" ]; then
  log_error "$APP_DIR is not writable. Re-run from an administrator account or use --app-dir \"$HOME/Applications\"."
  exit 1
fi

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/infinite-desktop-installer.XXXXXX")"
DMG_PATH="$TEMP_ROOT/Infinite.dmg"
MOUNT_POINT="$TEMP_ROOT/mount"
STAGE_ROOT="$(mktemp -d "$APP_DIR/.infinite-installer.XXXXXX")"
STAGED_APP="$STAGE_ROOT/Infinite.app"
MOUNTED=false

cleanup() {
  if [ "$MOUNTED" = true ]; then
    hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$STAGE_ROOT" "$TEMP_ROOT"
}
trap cleanup EXIT INT TERM

mkdir -p "$MOUNT_POINT"
log_info "Downloading Infinite from infinite.fast…"
# This must remain an ordinary GET to /download: the website records the download attempt there.
curl --fail --location --silent --show-error --retry 3 --connect-timeout 20 \
  --user-agent "$INSTALLER_USER_AGENT" --output "$DMG_PATH" "$DOWNLOAD_REQUEST_URL"

log_info "Mounting the signed release…"
hdiutil attach "$DMG_PATH" -readonly -nobrowse -noautoopen -mountpoint "$MOUNT_POINT" >/dev/null
MOUNTED=true

SOURCE_APP="$MOUNT_POINT/Infinite.app"
if ! verify_infinite_app "$SOURCE_APP"; then
  log_error "The downloaded app failed its bundle identity, Developer ID signature, or notarization check."
  exit 1
fi
log_success "Verified Developer ID signature, team, bundle identity, and notarization"

if [ -e "$TARGET_APP" ]; then
  log_error "$TARGET_APP appeared during installation; it was left untouched."
  exit 1
fi

ditto "$SOURCE_APP" "$STAGED_APP"
if ! verify_infinite_app "$STAGED_APP"; then
  log_error "The staged app failed verification; nothing was installed."
  exit 1
fi
mv "$STAGED_APP" "$TARGET_APP"

hdiutil detach "$MOUNT_POINT" -quiet >/dev/null
MOUNTED=false

migrate_legacy_launcher
log_success "Installed Infinite at $TARGET_APP"
log_info "The bundled engine and CLI require no separate Docker, Node, or npm installation."
launch_if_requested
