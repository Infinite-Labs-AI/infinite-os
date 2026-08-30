#!/usr/bin/env bash
set -euo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/infinite-desktop-installer-smoke.XXXXXX")"
fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
trap 'rm -rf "$test_root"' EXIT

write_fake_commands() {
  cat > "$fake_bin/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -s) printf '%s\n' "${FAKE_OS:-Darwin}" ;;
  -m) printf '%s\n' "${FAKE_ARCH:-arm64}" ;;
  *) exit 2 ;;
esac
EOF

  cat > "$fake_bin/sw_vers" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = "-productVersion" ] || exit 2
printf '%s\n' "${FAKE_MACOS_VERSION:-14.6}"
EOF

  cat > "$fake_bin/sysctl" <<'EOF'
#!/usr/bin/env bash
case "${*: -1}" in
  sysctl.proc_translated) printf '%s\n' "${FAKE_TRANSLATED:-0}" ;;
  hw.optional.arm64) printf '%s\n' "${FAKE_ARM64_CAPABLE:-0}" ;;
  *) exit 1 ;;
esac
EOF

  cat > "$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
output=""
url=""
user_agent=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --user-agent) user_agent="$2"; shift 2 ;;
    --retry|--connect-timeout) shift 2 ;;
    --*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf 'GET %s UA=%s\n' "$url" "$user_agent" >> "$FAKE_LOG"
[ -n "$output" ] || exit 2
: > "$output"
EOF

  cat > "$fake_bin/hdiutil" <<'EOF'
#!/usr/bin/env bash
operation="$1"
shift
case "$operation" in
  verify)
    printf 'verify %s\n' "$1" >> "$FAKE_LOG"
    [ "${FAKE_DMG_VERIFY_FAIL:-0}" != "1" ]
    ;;
  attach)
    mount_point=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -mountpoint) mount_point="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    source_app="$mount_point/Infinite.app"
    if [ "${FAKE_SOURCE_SYMLINK:-0}" = "1" ]; then
      source_app="$mount_point/RealInfinite.app"
    fi
    mkdir -p "$source_app/Contents/MacOS"
    : > "$source_app/Contents/MacOS/Infinite"
    : > "$source_app/Contents/Info.plist"
    printf '%s\n' "${FAKE_SOURCE_VERSION:-0.3.13}" > "$source_app/Contents/.version"
    [ "${FAKE_SOURCE_SYMLINK:-0}" != "1" ] || ln -s "$source_app" "$mount_point/Infinite.app"
    printf 'attach %s\n' "$mount_point" >> "$FAKE_LOG"
    ;;
  detach)
    printf 'detach %s\n' "$1" >> "$FAKE_LOG"
    ;;
  *) exit 2 ;;
esac
EOF

  cat > "$fake_bin/codesign" <<'EOF'
#!/usr/bin/env bash
app_path="${*: -1}"
if [ -n "${FAKE_BAD_SIGNATURE_PATH:-}" ] && [[ "$app_path" == *"$FAKE_BAD_SIGNATURE_PATH"* ]]; then exit 1; fi
if [ "${FAKE_FAIL_NEW_TARGET:-0}" = "1" ] && [[ "$app_path" == */apps/Infinite.app ]] \
  && [ "$(cat "$app_path/Contents/.version" 2>/dev/null || true)" = "0.3.13" ]; then exit 1; fi
case " $* " in
  *" --verify "*) exit 0 ;;
esac
printf '%s\n' 'Executable=/verified/Infinite' >&2
printf 'Identifier=%s\n' "${FAKE_BUNDLE_ID:-inc.ultima.infiniteos-desktop}" >&2
printf 'TeamIdentifier=%s\n' "${FAKE_TEAM_ID:-4659K3678P}" >&2
EOF

  cat > "$fake_bin/spctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  cat > "$fake_bin/ditto" <<'EOF'
#!/usr/bin/env bash
[ "${FAKE_DITTO_FAIL:-0}" != "1" ] || exit 1
cp -R "$1" "$2"
[ -z "${FAKE_RACE_TARGET:-}" ] || mkdir -p "$FAKE_RACE_TARGET"
[ "${FAKE_SIGNAL_DURING_DITTO:-0}" != "1" ] || kill -TERM "$PPID"
EOF

  cat > "$fake_bin/open" <<'EOF'
#!/usr/bin/env bash
printf 'open %s\n' "$1" >> "$FAKE_LOG"
[ "${FAKE_OPEN_FAIL:-0}" != "1" ]
EOF

  cat > "$fake_bin/PlistBuddy" <<'EOF'
#!/usr/bin/env bash
plist="${*: -1}"
cat "$(dirname "$plist")/.version"
EOF

  cat > "$fake_bin/pgrep" <<'EOF'
#!/usr/bin/env bash
[ -z "${FAKE_PROCESS_TABLE:-}" ] || { [ ! -s "$FAKE_PROCESS_TABLE" ] || cut -d '|' -f 1 "$FAKE_PROCESS_TABLE"; exit 0; }
[ -n "${FAKE_RUNNING_FILE:-}" ] && [ -s "$FAKE_RUNNING_FILE" ] && cat "$FAKE_RUNNING_FILE"
exit 0
EOF

  cat > "$fake_bin/ps" <<'EOF'
#!/usr/bin/env bash
if [ -n "${FAKE_PROCESS_TABLE:-}" ]; then
  pid=""
  while [ $# -gt 0 ]; do
    case "$1" in -p) pid="$2"; shift 2 ;; *) shift ;; esac
  done
  awk -F '|' -v wanted="$pid" '$1 == wanted { sub(/^[^|]*\|/, ""); print; exit }' "$FAKE_PROCESS_TABLE"
  exit 0
fi
printf '%s\n' "${FAKE_RUNNING_APP:-}/Contents/MacOS/Infinite"
EOF

  cat > "$fake_bin/osascript" <<'EOF'
#!/usr/bin/env bash
printf 'quit\n' >> "$FAKE_LOG"
[ -z "${FAKE_PROCESS_TABLE:-}" ] || : > "$FAKE_PROCESS_TABLE"
[ -z "${FAKE_RUNNING_FILE:-}" ] || : > "$FAKE_RUNNING_FILE"
EOF

  cat > "$fake_bin/stat" <<'EOF'
#!/usr/bin/env bash
path="${*: -1}"
inode="$(/bin/ls -di "$path" | /usr/bin/awk '{print $1}')"
printf '1:%s\n' "$inode"
EOF

  cat > "$fake_bin/mv" <<'EOF'
#!/usr/bin/env bash
/bin/mv "$@"
source_path="$2"
destination_path="${*: -1}"
if [ "${FAKE_SIGNAL_AFTER_COMMIT:-0}" = "1" ] \
  && [[ "$source_path" == */.infinite-installer.*/Infinite.app ]] \
  && [[ "$destination_path" == */apps/ ]]; then
  kill -TERM "$PPID"
fi
EOF

  chmod +x "$fake_bin"/*
}

run_installer() {
  case_name="$1"
  shift
  case_root="$test_root/$case_name"
  mkdir -p "$case_root/home" "$case_root/apps"
  : > "$case_root/log"
  env \
    HOME="$case_root/home" \
    PATH="$fake_bin:/usr/bin:/bin" \
    FAKE_LOG="$case_root/log" \
    INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
    "$@" \
    bash "$repo_root/scripts/install.sh" --app-dir "$case_root/apps"
}

write_fake_commands

create_app() {
  app="$1"
  version="$2"
  mkdir -p "$app/Contents/MacOS"
  : > "$app/Contents/MacOS/Infinite"
  : > "$app/Contents/Info.plist"
  printf '%s\n' "$version" > "$app/Contents/.version"
}

fixture_fingerprint() {
  /bin/ls -di "$1" | /usr/bin/awk '{print $1}'
}

# Fresh install: one truthful GET through /download, verified staging, mount cleanup, and launch.
run_installer fresh env
test -d "$test_root/fresh/apps/Infinite.app"
grep -Fq 'GET https://infinite.fast/download?utm_source=github&utm_medium=cli&utm_campaign=infinite_os_install UA=Infinite-Installer/1.0.1' "$test_root/fresh/log"
grep -Fq 'verify ' "$test_root/fresh/log"
grep -Fq 'detach ' "$test_root/fresh/log"
grep -Fq "open $test_root/fresh/apps/Infinite.app" "$test_root/fresh/log"
if find "$test_root/fresh/apps" -maxdepth 1 -name '.infinite-installer.*' | grep -q .; then
  printf 'same-volume staging directory was not cleaned up\n' >&2
  exit 1
fi

# An existing same-version verified app is opened without replacement.
mkdir -p "$test_root/existing/home" "$test_root/existing/apps"
create_app "$test_root/existing/apps/Infinite.app" 0.3.13
: > "$test_root/existing/log"
existing_before="$(fixture_fingerprint "$test_root/existing/apps/Infinite.app")"
env HOME="$test_root/existing/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/existing/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/existing/apps"
existing_after="$(fixture_fingerprint "$test_root/existing/apps/Infinite.app")"
test "$existing_before" = "$existing_after"
grep -Fq "open $test_root/existing/apps/Infinite.app" "$test_root/existing/log"

# A safe installed target still quits an older verified copy running from another path before open.
mkdir -p "$test_root/other_running/home" "$test_root/other_running/apps" "$test_root/other_running/downloads"
create_app "$test_root/other_running/apps/Infinite.app" 0.3.13
create_app "$test_root/other_running/downloads/Infinite.app" 0.3.12
printf '5252\n' > "$test_root/other_running/pids"
: > "$test_root/other_running/log"
env HOME="$test_root/other_running/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/other_running/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  FAKE_RUNNING_FILE="$test_root/other_running/pids" FAKE_RUNNING_APP="$test_root/other_running/downloads/Infinite.app" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/other_running/apps"
grep -Fq quit "$test_root/other_running/log"
grep -Fq "open $test_root/other_running/apps/Infinite.app" "$test_root/other_running/log"

# Exact production shapes: a verified GUI main plus its bundled daemon are one legitimate app tree.
mkdir -p "$test_root/gui_daemon/home" "$test_root/gui_daemon/apps"
create_app "$test_root/gui_daemon/apps/Infinite.app" 0.3.13
mkdir -p "$test_root/gui_daemon/apps/Infinite.app/Contents/Resources/daemon"
: > "$test_root/gui_daemon/apps/Infinite.app/Contents/Resources/daemon/daemon.mjs"
gui_daemon_exec="$test_root/gui_daemon/apps/Infinite.app/Contents/MacOS/Infinite"
printf '6101|%s\n6102|%s %s\n' \
  "$gui_daemon_exec" \
  "$gui_daemon_exec" \
  "$test_root/gui_daemon/apps/Infinite.app/Contents/Resources/daemon/daemon.mjs" \
  > "$test_root/gui_daemon/processes"
: > "$test_root/gui_daemon/log"
env HOME="$test_root/gui_daemon/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/gui_daemon/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  FAKE_PROCESS_TABLE="$test_root/gui_daemon/processes" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/gui_daemon/apps"
grep -Fq quit "$test_root/gui_daemon/log"
grep -Fq "open $test_root/gui_daemon/apps/Infinite.app" "$test_root/gui_daemon/log"

# A fresh isolated --no-open install does not disturb an unrelated verified prod GUI/daemon pair.
mkdir -p "$test_root/isolated_no_open/home" "$test_root/isolated_no_open/apps" "$test_root/isolated_no_open/prod"
create_app "$test_root/isolated_no_open/prod/Infinite.app" 0.3.13
mkdir -p "$test_root/isolated_no_open/prod/Infinite.app/Contents/Resources/daemon"
: > "$test_root/isolated_no_open/prod/Infinite.app/Contents/Resources/daemon/daemon.mjs"
isolated_prod_exec="$test_root/isolated_no_open/prod/Infinite.app/Contents/MacOS/Infinite"
printf '6201|%s\n6202|%s %s\n' \
  "$isolated_prod_exec" \
  "$isolated_prod_exec" \
  "$test_root/isolated_no_open/prod/Infinite.app/Contents/Resources/daemon/daemon.mjs" \
  > "$test_root/isolated_no_open/processes"
: > "$test_root/isolated_no_open/log"
env HOME="$test_root/isolated_no_open/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/isolated_no_open/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  FAKE_PROCESS_TABLE="$test_root/isolated_no_open/processes" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/isolated_no_open/apps" --no-open
test -d "$test_root/isolated_no_open/apps/Infinite.app"
test -s "$test_root/isolated_no_open/processes"
! grep -q '^quit$' "$test_root/isolated_no_open/log"

# The exact legacy installer wrapper is preserved for launcher-safe Desktop to migrate atomically.
mkdir -p "$test_root/legacy/home/.local/bin" "$test_root/legacy/apps"
create_app "$test_root/legacy/apps/Infinite.app" 0.3.13
: > "$test_root/legacy/log"
cat > "$test_root/legacy/home/.local/bin/infinite" <<'EOF'
#!/usr/bin/env bash
# Infinite launcher shim — installed by scripts/install.sh.
# Runs Infinite from anywhere by handing off to the checkout below.
# If you move the repo, update this path.
exec "/example/.infinite/app/infinite" "$@"
EOF
env HOME="$test_root/legacy/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/legacy/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/legacy/apps" --no-open
test -f "$test_root/legacy/home/.local/bin/infinite"
test ! -e "$test_root/legacy/home/.local/bin/infinite.legacy-installer"

# A foreign/current launcher is preserved byte-for-byte by the launcher-safe Desktop release.
mkdir -p "$test_root/foreign/home/.local/bin" "$test_root/foreign/apps"
: > "$test_root/foreign/log"
printf '%s\n' '#!/bin/sh' \
  'exec env ELECTRON_RUN_AS_NODE=1 "/Applications/Infinite.app/Contents/MacOS/Infinite" "/Applications/Infinite.app/Contents/Resources/cli/infinite.mjs" "$@"' \
  > "$test_root/foreign/home/.local/bin/infinite"
foreign_before="$(shasum -a 256 "$test_root/foreign/home/.local/bin/infinite")"
env HOME="$test_root/foreign/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/foreign/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/foreign/apps"
foreign_after="$(shasum -a 256 "$test_root/foreign/home/.local/bin/infinite")"
test "$foreign_before" = "$foreign_after"
grep -q '^open ' "$test_root/foreign/log"

# Older installs are upgraded; newer installs are retained.
mkdir -p "$test_root/older/home" "$test_root/older/apps"
create_app "$test_root/older/apps/Infinite.app" 0.3.12
: > "$test_root/older/log"
env HOME="$test_root/older/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/older/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/older/apps" --no-open
test "$(cat "$test_root/older/apps/Infinite.app/Contents/.version")" = 0.3.13
! find "$test_root/older/apps" -maxdepth 1 -name '.infinite-backup.*' | grep -q .

mkdir -p "$test_root/newer/home" "$test_root/newer/apps"
create_app "$test_root/newer/apps/Infinite.app" 0.3.14
newer_before="$(fixture_fingerprint "$test_root/newer/apps/Infinite.app")"
: > "$test_root/newer/log"
env HOME="$test_root/newer/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/newer/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/newer/apps" --no-open
test "$newer_before" = "$(fixture_fingerprint "$test_root/newer/apps/Infinite.app")"

# A pre-safety public release is never installed or opened.
if run_installer unsafe_source env FAKE_SOURCE_VERSION=0.3.12; then
  printf 'unsafe source release unexpectedly installed\n' >&2
  exit 1
fi
test ! -e "$test_root/unsafe_source/apps/Infinite.app"
! grep -q '^open ' "$test_root/unsafe_source/log"

# Wrong signing identity/team and source/destination symlinks fail closed.
if run_installer wrong_team env FAKE_TEAM_ID=WRONGTEAM; then
  printf 'wrong signing team unexpectedly installed\n' >&2
  exit 1
fi
test ! -e "$test_root/wrong_team/apps/Infinite.app"

if run_installer wrong_bundle env FAKE_BUNDLE_ID=example.wrong.bundle; then
  printf 'wrong bundle identity unexpectedly installed\n' >&2
  exit 1
fi
test ! -e "$test_root/wrong_bundle/apps/Infinite.app"

if run_installer wrong_signature env FAKE_BAD_SIGNATURE_PATH=mount; then
  printf 'bad signature unexpectedly installed\n' >&2
  exit 1
fi
test ! -e "$test_root/wrong_signature/apps/Infinite.app"

if run_installer bad_dmg env FAKE_DMG_VERIFY_FAIL=1; then
  printf 'invalid dmg unexpectedly mounted\n' >&2
  exit 1
fi
! grep -q '^attach ' "$test_root/bad_dmg/log"

if run_installer source_link env FAKE_SOURCE_SYMLINK=1; then
  printf 'source symlink unexpectedly installed\n' >&2
  exit 1
fi
test ! -e "$test_root/source_link/apps/Infinite.app"

mkdir -p "$test_root/dest_link/home" "$test_root/dest_link/apps"
ln -s "$test_root/dest_link/missing.app" "$test_root/dest_link/apps/Infinite.app"
: > "$test_root/dest_link/log"
if env HOME="$test_root/dest_link/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/dest_link/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/dest_link/apps"; then
  printf 'destination dangling symlink unexpectedly installed\n' >&2
  exit 1
fi
test -L "$test_root/dest_link/apps/Infinite.app"
! grep -q '^GET ' "$test_root/dest_link/log"

# A concurrent creator wins the no-clobber commit and remains untouched.
mkdir -p "$test_root/race/home" "$test_root/race/apps"
: > "$test_root/race/log"
if env HOME="$test_root/race/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/race/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  FAKE_RACE_TARGET="$test_root/race/apps/Infinite.app" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/race/apps"; then
  printf 'target race unexpectedly succeeded\n' >&2
  exit 1
fi
test -d "$test_root/race/apps/Infinite.app"
test ! -e "$test_root/race/apps/Infinite.app/Contents/.version"

# A running verified copy is asked to quit gracefully before upgrade.
mkdir -p "$test_root/running/home" "$test_root/running/apps"
create_app "$test_root/running/apps/Infinite.app" 0.3.12
printf '4242\n' > "$test_root/running/pids"
: > "$test_root/running/log"
env HOME="$test_root/running/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/running/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  FAKE_RUNNING_FILE="$test_root/running/pids" FAKE_RUNNING_APP="$test_root/running/apps/Infinite.app" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/running/apps" --no-open
grep -Fq quit "$test_root/running/log"
test "$(cat "$test_root/running/apps/Infinite.app/Contents/.version")" = 0.3.13

# Normal upgrade accepts the target app's exact GUI + bundled daemon shapes, then quiesces both.
mkdir -p "$test_root/running_pair/home" "$test_root/running_pair/apps"
create_app "$test_root/running_pair/apps/Infinite.app" 0.3.12
mkdir -p "$test_root/running_pair/apps/Infinite.app/Contents/Resources/daemon"
: > "$test_root/running_pair/apps/Infinite.app/Contents/Resources/daemon/daemon.mjs"
running_pair_exec="$test_root/running_pair/apps/Infinite.app/Contents/MacOS/Infinite"
printf '6301|%s\n6302|%s %s\n' \
  "$running_pair_exec" \
  "$running_pair_exec" \
  "$test_root/running_pair/apps/Infinite.app/Contents/Resources/daemon/daemon.mjs" \
  > "$test_root/running_pair/processes"
: > "$test_root/running_pair/log"
env HOME="$test_root/running_pair/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/running_pair/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  FAKE_PROCESS_TABLE="$test_root/running_pair/processes" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/running_pair/apps" --no-open
grep -Fq quit "$test_root/running_pair/log"
test ! -s "$test_root/running_pair/processes"
test "$(cat "$test_root/running_pair/apps/Infinite.app/Contents/.version")" = 0.3.13

# An unexpected same-name process remains a hard stop for an operation that replaces its target app.
mkdir -p "$test_root/running_unexpected/home" "$test_root/running_unexpected/apps"
create_app "$test_root/running_unexpected/apps/Infinite.app" 0.3.12
unexpected_exec="$test_root/running_unexpected/apps/Infinite.app/Contents/MacOS/Infinite"
printf '6401|%s --unexpected-child\n' "$unexpected_exec" > "$test_root/running_unexpected/processes"
: > "$test_root/running_unexpected/log"
if env HOME="$test_root/running_unexpected/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/running_unexpected/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  FAKE_PROCESS_TABLE="$test_root/running_unexpected/processes" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/running_unexpected/apps" --no-open; then
  printf 'unexpected same-name process did not block upgrade\n' >&2
  exit 1
fi
test "$(cat "$test_root/running_unexpected/apps/Infinite.app/Contents/.version")" = 0.3.12
test -s "$test_root/running_unexpected/processes"

# Post-commit verification and open failures roll an upgrade back to the previous verified app.
for failure_case in verify_rollback open_rollback; do
  mkdir -p "$test_root/$failure_case/home" "$test_root/$failure_case/apps"
  create_app "$test_root/$failure_case/apps/Infinite.app" 0.3.12
  : > "$test_root/$failure_case/log"
done
if env HOME="$test_root/verify_rollback/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/verify_rollback/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  FAKE_FAIL_NEW_TARGET=1 bash "$repo_root/scripts/install.sh" --app-dir "$test_root/verify_rollback/apps" --no-open; then
  printf 'post-commit verification failure unexpectedly succeeded\n' >&2
  exit 1
fi
test "$(cat "$test_root/verify_rollback/apps/Infinite.app/Contents/.version")" = 0.3.12
! find "$test_root/verify_rollback/apps" -maxdepth 1 -name '.infinite-backup.*' | grep -q .

if env HOME="$test_root/open_rollback/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/open_rollback/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  FAKE_OPEN_FAIL=1 bash "$repo_root/scripts/install.sh" --app-dir "$test_root/open_rollback/apps"; then
  printf 'open failure unexpectedly succeeded\n' >&2
  exit 1
fi
test "$(cat "$test_root/open_rollback/apps/Infinite.app/Contents/.version")" = 0.3.12
! find "$test_root/open_rollback/apps" -maxdepth 1 -name '.infinite-backup.*' | grep -q .

if run_installer fresh_open_failure env FAKE_OPEN_FAIL=1; then
  printf 'fresh open failure unexpectedly succeeded\n' >&2
  exit 1
fi
test ! -e "$test_root/fresh_open_failure/apps/Infinite.app"

# A terminating signal during staging leaves no app or staging directory.
if run_installer signal env FAKE_SIGNAL_DURING_DITTO=1; then
  printf 'signalled installer unexpectedly succeeded\n' >&2
  exit 1
fi
test ! -e "$test_root/signal/apps/Infinite.app"
! find "$test_root/signal/apps" -maxdepth 1 -name '.infinite-installer.*' | grep -q .
grep -Fq 'detach ' "$test_root/signal/log"

# A signal in the rename→state-assignment window is inferred from the staged inode and rolled back.
mkdir -p "$test_root/signal_commit/home" "$test_root/signal_commit/apps"
create_app "$test_root/signal_commit/apps/Infinite.app" 0.3.12
: > "$test_root/signal_commit/log"
if env HOME="$test_root/signal_commit/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/signal_commit/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  FAKE_SIGNAL_AFTER_COMMIT=1 bash "$repo_root/scripts/install.sh" --app-dir "$test_root/signal_commit/apps" --no-open; then
  printf 'commit-window signal unexpectedly succeeded\n' >&2
  exit 1
fi
test "$(cat "$test_root/signal_commit/apps/Infinite.app/Contents/.version")" = 0.3.12
! find "$test_root/signal_commit/apps" -maxdepth 1 \( -name '.infinite-installer.*' -o -name '.infinite-backup.*' \) | grep -q .

# --no-open performs a valid fresh install without invoking LaunchServices.
mkdir -p "$test_root/no_open/home" "$test_root/no_open/apps"
: > "$test_root/no_open/log"
env HOME="$test_root/no_open/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/no_open/log" INFINITE_PLIST_BUDDY="$fake_bin/PlistBuddy" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/no_open/apps" --no-open
test -d "$test_root/no_open/apps/Infinite.app"
! grep -q '^open ' "$test_root/no_open/log"

# Rosetta reports x86_64 for the process; physical Apple silicon remains supported.
run_installer rosetta env FAKE_ARCH=x86_64 FAKE_TRANSLATED=1 FAKE_ARM64_CAPABLE=1
test -d "$test_root/rosetta/apps/Infinite.app"

# Actual Intel and non-macOS hosts fail before any download.
if run_installer intel env FAKE_ARCH=x86_64 FAKE_TRANSLATED=0 FAKE_ARM64_CAPABLE=0; then
  printf 'Intel install unexpectedly succeeded\n' >&2
  exit 1
fi
! grep -q '^GET ' "$test_root/intel/log"

if run_installer linux env FAKE_OS=Linux; then
  printf 'Linux install unexpectedly succeeded\n' >&2
  exit 1
fi
! grep -q '^GET ' "$test_root/linux/log"

printf 'Infinite Desktop installer smoke passed\n'
