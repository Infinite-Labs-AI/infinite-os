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
  attach)
    mount_point=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -mountpoint) mount_point="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    mkdir -p "$mount_point/Infinite.app/Contents/MacOS"
    : > "$mount_point/Infinite.app/Contents/MacOS/Infinite"
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
case " $* " in
  *" --verify "*) exit 0 ;;
esac
printf '%s\n' 'Executable=/verified/Infinite' >&2
printf '%s\n' 'Identifier=inc.ultima.infiniteos-desktop' >&2
printf '%s\n' 'TeamIdentifier=4659K3678P' >&2
EOF

  cat > "$fake_bin/spctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  cat > "$fake_bin/ditto" <<'EOF'
#!/usr/bin/env bash
cp -R "$1" "$2"
EOF

  cat > "$fake_bin/open" <<'EOF'
#!/usr/bin/env bash
printf 'open %s\n' "$1" >> "$FAKE_LOG"
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
    "$@" \
    bash "$repo_root/scripts/install.sh" --app-dir "$case_root/apps"
}

write_fake_commands

# Fresh install: one truthful GET through /download, verified staging, mount cleanup, and launch.
run_installer fresh env
test -d "$test_root/fresh/apps/Infinite.app"
grep -Fq 'GET https://infinite.fast/download?utm_source=github&utm_medium=cli&utm_campaign=infinite_os_install UA=Infinite-Installer/1.0.0' "$test_root/fresh/log"
grep -Fq 'detach ' "$test_root/fresh/log"
grep -Fq "open $test_root/fresh/apps/Infinite.app" "$test_root/fresh/log"
if find "$test_root/fresh/apps" -maxdepth 1 -name '.infinite-installer.*' | grep -q .; then
  printf 'same-volume staging directory was not cleaned up\n' >&2
  exit 1
fi

# An existing verified app is opened without another download or replacement.
mkdir -p "$test_root/existing/home" "$test_root/existing/apps/Infinite.app"
: > "$test_root/existing/log"
env HOME="$test_root/existing/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/existing/log" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/existing/apps"
! grep -q '^GET ' "$test_root/existing/log"
grep -Fq "open $test_root/existing/apps/Infinite.app" "$test_root/existing/log"

# The exact legacy installer wrapper is recoverably moved so Desktop can install its bundled CLI.
mkdir -p "$test_root/legacy/home/.local/bin" "$test_root/legacy/apps/Infinite.app"
: > "$test_root/legacy/log"
cat > "$test_root/legacy/home/.local/bin/infinite" <<'EOF'
#!/usr/bin/env bash
# Infinite launcher shim — installed by scripts/install.sh.
# Runs Infinite from anywhere by handing off to the checkout below.
# If you move the repo, update this path.
exec "/example/.infinite/app/infinite" "$@"
EOF
env HOME="$test_root/legacy/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/legacy/log" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/legacy/apps" --no-open
test ! -e "$test_root/legacy/home/.local/bin/infinite"
test -f "$test_root/legacy/home/.local/bin/infinite.legacy-installer"

# A foreign command is preserved byte-for-byte and blocks auto-open on the affected Desktop release.
mkdir -p "$test_root/foreign/home/.local/bin" "$test_root/foreign/apps"
: > "$test_root/foreign/log"
printf '%s\n' '#!/bin/sh' 'echo foreign' > "$test_root/foreign/home/.local/bin/infinite"
foreign_before="$(shasum -a 256 "$test_root/foreign/home/.local/bin/infinite")"
env HOME="$test_root/foreign/home" PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/foreign/log" \
  bash "$repo_root/scripts/install.sh" --app-dir "$test_root/foreign/apps"
foreign_after="$(shasum -a 256 "$test_root/foreign/home/.local/bin/infinite")"
test "$foreign_before" = "$foreign_after"
! grep -q '^open ' "$test_root/foreign/log"

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
