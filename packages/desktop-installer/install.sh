#!/usr/bin/env bash
# Install the signed Infinite Desktop product for Apple-silicon Macs.
# The release command is published only after these exact bytes have an immutable commit URL.

set -euo pipefail
set -f

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
log_info() { printf "${CYAN}→${NC} %s\n" "$1"; }
log_success() { printf "${GREEN}✓${NC} %s\n" "$1"; }
log_warn() { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
log_error() { printf "${RED}✗${NC} %s\n" "$1" >&2; }

DOWNLOAD_URL="https://infinite.fast/download"
INSTALLER_USER_AGENT="Infinite-Installer/1.0.0"
EXPECTED_BUNDLE_ID="inc.ultima.infiniteos-desktop"
EXPECTED_TEAM_ID="4659K3678P"
# 0.3.13 is the first release containing the no-clobber Desktop CLI launcher.
MIN_SAFE_DESKTOP_VERSION="0.3.13"
APP_DIR="${INFINITE_APPLICATIONS_DIR:-/Applications}"
PLIST_BUDDY="${INFINITE_PLIST_BUDDY:-/usr/libexec/PlistBuddy}"
OPEN_APP=true

case "${INFINITE_INSTALL_SOURCE:-github}" in
  npm) DOWNLOAD_REQUEST_URL="${DOWNLOAD_URL}?utm_source=npm&utm_medium=cli&utm_campaign=infinite_os_install" ;;
  *) DOWNLOAD_REQUEST_URL="${DOWNLOAD_URL}?utm_source=github&utm_medium=cli&utm_campaign=infinite_os_install" ;;
esac

usage() {
  cat <<'EOF'
Infinite for macOS installer

Usage: install.sh [--app-dir PATH] [--no-open] [-h|--help]

Downloads, verifies, installs or upgrades, and opens the signed Infinite Desktop app.
The app includes its local engine, embedded database, and CLI.

Options:
  --app-dir PATH  Install directory (default: /Applications)
  --no-open       Install or upgrade without launching Infinite
  -h, --help      Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app-dir) [ $# -ge 2 ] || { log_error "--app-dir requires a path"; exit 2; }; APP_DIR="$2"; shift 2 ;;
    --no-open) OPEN_APP=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) log_error "Unknown option: $1"; usage >&2; exit 2 ;;
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
case "$MACOS_MAJOR" in ''|*[!0-9]*) log_error "Could not determine macOS version '$MACOS_VERSION'."; exit 1 ;; esac
if [ "$MACOS_MAJOR" -lt 12 ]; then
  log_error "Infinite requires macOS 12 or newer; found macOS $MACOS_VERSION."
  exit 1
fi

for command_name in curl hdiutil codesign spctl ditto sw_vers stat pgrep ps osascript open; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    if [ "$command_name" = "open" ] && [ "$OPEN_APP" != true ]; then continue; fi
    log_error "Required macOS command not found: $command_name"
    exit 1
  fi
done
if [ ! -x "$PLIST_BUDDY" ]; then
  log_error "Required macOS command not found: $PLIST_BUDDY"
  exit 1
fi

TARGET_APP="$APP_DIR/Infinite.app"
TEMP_ROOT=""
MOUNT_POINT=""
STAGE_ROOT=""
STAGED_APP=""
BACKUP_ROOT=""
BACKUP_APP=""
MOUNTED=false
INSTALL_COMMITTED=false
INSTALL_SUCCESS=false
UPGRADE=false
NEW_FINGERPRINT=""
ORIGINAL_FINGERPRINT=""

path_exists_or_link() { [ -e "$1" ] || [ -L "$1" ]; }

safe_remove_tree() {
  candidate="$1"
  prefix="$2"
  [ -n "$candidate" ] || return 0
  case "$candidate" in "$prefix"*) ;; *) log_warn "Refusing unsafe cleanup path: $candidate"; return 1 ;; esac
  [ ! -L "$candidate" ] || { log_warn "Refusing to follow cleanup symlink: $candidate"; return 1; }
  [ -d "$candidate" ] && rm -rf "$candidate"
}

app_fingerprint() { stat -f '%d:%i' "$1" 2>/dev/null; }

verify_infinite_app() {
  app_path="$1"
  [ -d "$app_path" ] && [ ! -L "$app_path" ] || return 1
  codesign --verify --deep --strict "$app_path" >/dev/null 2>&1 || return 1
  signature_details="$(codesign -dv --verbose=4 "$app_path" 2>&1)" || return 1
  bundle_id="$(printf '%s\n' "$signature_details" | sed -n 's/^Identifier=//p' | head -n 1)"
  team_id="$(printf '%s\n' "$signature_details" | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
  [ "$bundle_id" = "$EXPECTED_BUNDLE_ID" ] || return 1
  [ "$team_id" = "$EXPECTED_TEAM_ID" ] || return 1
  spctl --assess --type execute "$app_path" >/dev/null 2>&1 || return 1
}

read_app_version() {
  app_path="$1"
  info_plist="$app_path/Contents/Info.plist"
  [ -f "$info_plist" ] && [ ! -L "$info_plist" ] || return 1
  "$PLIST_BUDDY" -c 'Print :CFBundleShortVersionString' "$info_plist" 2>/dev/null
}

version_tuple() {
  value="$1"
  old_ifs="$IFS"; IFS=.; set -- $value; IFS="$old_ifs"
  [ $# -eq 3 ] || return 1
  for part in "$@"; do
    case "$part" in ''|*[!0-9]*) return 1 ;; esac
    [ "${#part}" -le 6 ] || return 1
  done
  printf '%s %s %s\n' "$1" "$2" "$3"
}

compare_versions() {
  left_tuple="$(version_tuple "$1")" || return 2
  right_tuple="$(version_tuple "$2")" || return 2
  set -- $left_tuple; l1=$1; l2=$2; l3=$3
  set -- $right_tuple; r1=$1; r2=$2; r3=$3
  for pair in "$l1:$r1" "$l2:$r2" "$l3:$r3"; do
    left="${pair%%:*}"; right="${pair#*:}"
    while [ "${left#0}" != "$left" ]; do left="${left#0}"; done; [ -n "$left" ] || left=0
    while [ "${right#0}" != "$right" ]; do right="${right#0}"; done; [ -n "$right" ] || right=0
    if [ "$left" -lt "$right" ]; then printf '%s\n' -1; return; fi
    if [ "$left" -gt "$right" ]; then printf '%s\n' 1; return; fi
  done
  printf '%s\n' 0
}

rollback_upgrade() {
  if [ "$INSTALL_COMMITTED" = true ] && path_exists_or_link "$TARGET_APP"; then
    current_fingerprint="$(app_fingerprint "$TARGET_APP" || true)"
    if [ -n "$NEW_FINGERPRINT" ] && [ "$current_fingerprint" = "$NEW_FINGERPRINT" ] && [ -n "$STAGE_ROOT" ]; then
      mv -n "$TARGET_APP" "$STAGE_ROOT/" || true
    else
      log_warn "Installed target changed concurrently; preserving it instead of deleting it."
    fi
  fi
  if [ "$UPGRADE" = true ] && [ -d "$BACKUP_APP" ] && [ ! -L "$BACKUP_APP" ]; then
    if ! path_exists_or_link "$TARGET_APP"; then
      mv -n "$BACKUP_APP" "$APP_DIR/" || true
      if verify_infinite_app "$TARGET_APP"; then log_warn "Restored the previous Infinite app."; fi
    else
      log_warn "Could not restore automatically because $TARGET_APP is occupied."
      log_warn "The verified previous app remains at $BACKUP_APP"
    fi
  fi
}

cleanup() {
  exit_status=$?
  trap - EXIT HUP INT TERM
  if [ "$INSTALL_SUCCESS" != true ]; then rollback_upgrade; fi
  if [ "$MOUNTED" = true ] && [ -n "$MOUNT_POINT" ]; then
    hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 \
      || hdiutil detach "$MOUNT_POINT" -force -quiet >/dev/null 2>&1 \
      || true
  fi
  if [ -n "$STAGE_ROOT" ]; then safe_remove_tree "$STAGE_ROOT" "$APP_DIR/.infinite-installer." || true; fi
  if [ -n "$TEMP_ROOT" ]; then safe_remove_tree "$TEMP_ROOT" "${TMPDIR:-/tmp}/infinite-desktop-installer." || true; fi
  if [ -n "$BACKUP_ROOT" ] && [ ! -d "$BACKUP_APP" ]; then
    safe_remove_tree "$BACKUP_ROOT" "$APP_DIR/.infinite-backup." || true
  elif [ "$INSTALL_SUCCESS" = true ] && [ -n "$BACKUP_ROOT" ]; then
    safe_remove_tree "$BACKUP_ROOT" "$APP_DIR/.infinite-backup." || true
  fi
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

migrate_legacy_launcher() {
  launcher="$HOME/.local/bin/infinite"
  marker='# Infinite launcher shim — installed by scripts/install.sh.'
  [ -e "$launcher" ] || return 0
  if [ -f "$launcher" ] && [ ! -L "$launcher" ] && grep -Fq "$marker" "$launcher" \
    && grep -Eq '^exec ".*/\.infinite/app/infinite" "\$@"$' "$launcher"; then
    log_info "Found the legacy installer-owned CLI wrapper; launcher-safe Desktop will migrate it."
  else
    log_warn "An existing 'infinite' command is not legacy-installer-owned; preserving it."
  fi
}

running_infinite_pids() { pgrep -x Infinite 2>/dev/null || true; }

quit_running_infinite_apps() {
  pids="$(running_infinite_pids)"
  [ -n "$pids" ] || return 0
  for pid in $pids; do
    executable="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$executable" in
      */Infinite.app/Contents/MacOS/Infinite)
        running_app="${executable%/Contents/MacOS/Infinite}"
        if ! verify_infinite_app "$running_app"; then
          log_error "Refusing to quit unverified process $pid at $executable"
          return 1
        fi
        ;;
      *) log_error "Refusing to quit unexpected process $pid named Infinite: $executable"; return 1 ;;
    esac
  done
  log_info "Asking the running Infinite app to quit…"
  osascript -e "tell application id \"$EXPECTED_BUNDLE_ID\" to quit" >/dev/null
  attempts=0
  while [ -n "$(running_infinite_pids)" ] && [ "$attempts" -lt 20 ]; do sleep 0.5; attempts=$((attempts + 1)); done
  if [ -n "$(running_infinite_pids)" ]; then
    log_error "Infinite did not quit. Close it and run the installer again."
    return 1
  fi
}

launch_if_requested() {
  [ "$OPEN_APP" = true ] || return 0
  installed_version="$(read_app_version "$TARGET_APP")" || return 1
  comparison="$(compare_versions "$installed_version" "$MIN_SAFE_DESKTOP_VERSION")" || return 1
  if [ "$comparison" -lt 0 ]; then
    log_error "Refusing to open unsafe Infinite $installed_version; minimum safe is $MIN_SAFE_DESKTOP_VERSION."
    return 1
  fi
  log_info "Opening Infinite ${installed_version}…"
  open "$TARGET_APP"
}

if path_exists_or_link "$APP_DIR" && [ -L "$APP_DIR" ]; then
  log_error "Install directory is a symlink; refusing: $APP_DIR"
  exit 1
fi
mkdir -p "$APP_DIR"
if [ ! -d "$APP_DIR" ] || [ ! -w "$APP_DIR" ]; then
  log_error "$APP_DIR is not a writable directory. Use --app-dir \"$HOME/Applications\" if needed."
  exit 1
fi
if [ -L "$TARGET_APP" ]; then
  log_error "Destination is a symlink (including a dangling symlink); refusing: $TARGET_APP"
  exit 1
fi

# The EXIT trap is active before the first temporary allocation.
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/infinite-desktop-installer.XXXXXX")"
DMG_PATH="$TEMP_ROOT/Infinite.dmg"
MOUNT_POINT="$TEMP_ROOT/mount"
mkdir -p "$MOUNT_POINT"

log_info "Downloading Infinite from infinite.fast…"
curl --fail --location --silent --show-error --retry 3 --connect-timeout 20 \
  --proto '=https' --proto-redir '=https' --user-agent "$INSTALLER_USER_AGENT" \
  --output "$DMG_PATH" "$DOWNLOAD_REQUEST_URL"

log_info "Verifying and mounting the release image…"
hdiutil verify "$DMG_PATH" >/dev/null
hdiutil attach "$DMG_PATH" -readonly -nobrowse -noautoopen -mountpoint "$MOUNT_POINT" >/dev/null
MOUNTED=true
SOURCE_APP="$MOUNT_POINT/Infinite.app"
if [ -L "$SOURCE_APP" ] || ! verify_infinite_app "$SOURCE_APP"; then
  log_error "Downloaded app failed source-path, identity, signature, or notarization verification."
  exit 1
fi
SOURCE_VERSION="$(read_app_version "$SOURCE_APP")" || { log_error "Downloaded app has no valid version."; exit 1; }
SAFE_COMPARISON="$(compare_versions "$SOURCE_VERSION" "$MIN_SAFE_DESKTOP_VERSION")" || { log_error "Invalid release version: $SOURCE_VERSION"; exit 1; }
if [ "$SAFE_COMPARISON" -lt 0 ]; then
  log_error "Latest public release $SOURCE_VERSION is older than required safe release $MIN_SAFE_DESKTOP_VERSION."
  log_error "Nothing was installed or opened. Retry after the safe release is live."
  exit 1
fi

EXISTING_VERSION=""
if path_exists_or_link "$TARGET_APP"; then
  [ ! -L "$TARGET_APP" ] || { log_error "Destination became a symlink; refusing."; exit 1; }
  verify_infinite_app "$TARGET_APP" || { log_error "Existing $TARGET_APP is not verified; it was left untouched."; exit 1; }
  EXISTING_VERSION="$(read_app_version "$TARGET_APP")" || { log_error "Existing app has no valid version."; exit 1; }
  EXISTING_COMPARISON="$(compare_versions "$EXISTING_VERSION" "$SOURCE_VERSION")" || { log_error "Invalid existing version: $EXISTING_VERSION"; exit 1; }
  if [ "$EXISTING_COMPARISON" -ge 0 ]; then
    log_success "Infinite $EXISTING_VERSION is already installed (downloaded release: $SOURCE_VERSION)."
    migrate_legacy_launcher
    launch_if_requested
    INSTALL_SUCCESS=true
    exit 0
  fi
  UPGRADE=true
  log_info "Upgrading Infinite $EXISTING_VERSION → $SOURCE_VERSION"
fi

STAGE_ROOT="$(mktemp -d "$APP_DIR/.infinite-installer.XXXXXX")"
STAGED_APP="$STAGE_ROOT/Infinite.app"
ditto "$SOURCE_APP" "$STAGED_APP"
verify_infinite_app "$STAGED_APP" || { log_error "Staged app failed verification."; exit 1; }
STAGED_VERSION="$(read_app_version "$STAGED_APP")" || exit 1
[ "$STAGED_VERSION" = "$SOURCE_VERSION" ] || { log_error "Staged app version changed unexpectedly."; exit 1; }

quit_running_infinite_apps

if [ "$UPGRADE" = true ]; then
  [ ! -L "$TARGET_APP" ] && verify_infinite_app "$TARGET_APP" || { log_error "Existing app changed before upgrade."; exit 1; }
  CURRENT_VERSION="$(read_app_version "$TARGET_APP")" || exit 1
  [ "$CURRENT_VERSION" = "$EXISTING_VERSION" ] || { log_error "Existing app version changed before upgrade."; exit 1; }
  ORIGINAL_FINGERPRINT="$(app_fingerprint "$TARGET_APP")" || exit 1
  BACKUP_ROOT="$(mktemp -d "$APP_DIR/.infinite-backup.XXXXXX")"
  BACKUP_APP="$BACKUP_ROOT/Infinite.app"
  mv -n "$TARGET_APP" "$BACKUP_ROOT/"
  if path_exists_or_link "$TARGET_APP" || [ ! -d "$BACKUP_APP" ]; then
    log_error "Could not exclusively move the existing app into backup."
    exit 1
  fi
  [ "$(app_fingerprint "$BACKUP_APP")" = "$ORIGINAL_FINGERPRINT" ] \
    && verify_infinite_app "$BACKUP_APP" \
    && [ "$(read_app_version "$BACKUP_APP")" = "$EXISTING_VERSION" ] \
    || { log_error "Backup identity changed; aborting and restoring."; exit 1; }
fi

# BSD mv -n is the no-replace commit: a concurrent creator wins and is never overwritten.
mv -n "$STAGED_APP" "$APP_DIR/"
if path_exists_or_link "$STAGED_APP" || [ ! -d "$TARGET_APP" ] || [ -L "$TARGET_APP" ]; then
  log_error "Install target was occupied concurrently; it was not overwritten."
  exit 1
fi
INSTALL_COMMITTED=true
NEW_FINGERPRINT="$(app_fingerprint "$TARGET_APP")" || exit 1
verify_infinite_app "$TARGET_APP" || { log_error "Committed app failed verification; rolling back."; exit 1; }
[ "$(read_app_version "$TARGET_APP")" = "$SOURCE_VERSION" ] || { log_error "Committed version mismatch; rolling back."; exit 1; }

migrate_legacy_launcher
launch_if_requested
INSTALL_SUCCESS=true
log_success "Installed Infinite $SOURCE_VERSION at $TARGET_APP"
log_info "The bundled engine and CLI require no separate Docker, Node, or npm installation."
