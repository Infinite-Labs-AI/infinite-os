#!/usr/bin/env bash
# Smoke for scripts/install.sh (the `npx infinite-os@latest` payload).
#
# 2026-10-16: the Mac download sits behind sign-up, so the installer opens
# https://infinite.fast/get-started?cta=cli… in the browser and never downloads or installs anything itself.
# Fake `open`, `uname`, `curl` and `hdiutil` record every call, so this proves both halves: the sign-up page is
# opened exactly as specified, and no DMG transfer or disk-image command is ever attempted.
set -euo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/infinite-desktop-installer-smoke.XXXXXX")"
fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
trap 'rm -rf "$test_root"' EXIT

cat > "$fake_bin/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -s) printf '%s\n' "${FAKE_OS:-Darwin}" ;;
  -m) printf '%s\n' "arm64" ;;
  *) exit 2 ;;
esac
EOF
cat > "$fake_bin/open" <<'EOF'
#!/usr/bin/env bash
printf 'open <%s>\n' "$*" >> "$FAKE_LOG"
[ "${FAKE_OPEN_FAILS:-0}" != "1" ] || exit 1
EOF
for forbidden in curl hdiutil codesign spctl ditto; do
  cat > "$fake_bin/$forbidden" <<EOF
#!/usr/bin/env bash
printf '$forbidden <%s>\n' "\$*" >> "\$FAKE_LOG"
exit 99
EOF
done
chmod +x "$fake_bin"/*

fail() { printf 'install-smoke: %s\n' "$1" >&2; exit 1; }

# run_installer <case> [env assignments…] [-- installer args…]
run_installer() {
  name="$1"; shift
  case_dir="$test_root/$name"
  mkdir -p "$case_dir/Applications"
  : > "$case_dir/log"
  envs=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  [ "${1:-}" != "--" ] || shift
  set +e
  env PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$case_dir/log" INFINITE_APPLICATIONS_DIR="$case_dir/Applications" \
    ${envs[@]+"${envs[@]}"} /bin/bash "$repo_root/scripts/install.sh" "$@" > "$case_dir/out" 2> "$case_dir/err"
  status=$?
  set -e
  printf '%s' "$status" > "$case_dir/status"
}

status_of() { cat "$test_root/$1/status"; }
assert_no_download() {
  if grep -Eq '^(curl|hdiutil|codesign|spctl|ditto) ' "$test_root/$1/log"; then fail "$1: attempted a download/install command"; fi
}

GITHUB_URL='https://infinite.fast/get-started?cta=cli&utm_source=github&utm_medium=cli&utm_campaign=infinite_os_install'
NPM_URL='https://infinite.fast/get-started?cta=cli&utm_source=npm&utm_medium=cli&utm_campaign=infinite_os_install'

# The bundled npm payload is the canonical installer, byte for byte.
cmp -s "$repo_root/scripts/install.sh" "$repo_root/packages/desktop-installer/install.sh" \
  || fail "packages/desktop-installer/install.sh differs from scripts/install.sh"

# Interactive, nothing installed: one line, then the sign-up page opens in the default browser.
run_installer fresh INFINITE_INSTALL_INTERACTIVE=1
[ "$(status_of fresh)" = 0 ] || fail "fresh: exit $(status_of fresh)"
[ "$(cat "$test_root/fresh/out")" = "Sign up to download Infinite: opening infinite.fast/get-started…" ] || fail "fresh: unexpected output"
[ "$(cat "$test_root/fresh/log")" = "open <$GITHUB_URL>" ] || fail "fresh: did not open exactly the sign-up page"
assert_no_download fresh

# The npm caller changes only the attribution parameter.
run_installer npm_source INFINITE_INSTALL_INTERACTIVE=1 INFINITE_INSTALL_SOURCE=npm
[ "$(cat "$test_root/npm_source/log")" = "open <$NPM_URL>" ] || fail "npm_source: wrong sign-up URL"
assert_no_download npm_source

# `open` failing prints the link instead, still a success.
run_installer open_fails INFINITE_INSTALL_INTERACTIVE=1 FAKE_OPEN_FAILS=1
[ "$(status_of open_fails)" = 0 ] || fail "open_fails: exit $(status_of open_fails)"
grep -Fxq "Sign up to download Infinite: $GITHUB_URL" "$test_root/open_fails/out" || fail "open_fails: link not printed"
assert_no_download open_fails

# A non-interactive caller (CI, a pipe) and --no-open print the link and never open a browser.
for case_name in noninteractive no_open; do
  if [ "$case_name" = noninteractive ]; then run_installer noninteractive INFINITE_INSTALL_INTERACTIVE=0
  else run_installer no_open INFINITE_INSTALL_INTERACTIVE=1 -- --no-open; fi
  [ "$(status_of "$case_name")" = 0 ] || fail "$case_name: exit $(status_of "$case_name")"
  [ "$(cat "$test_root/$case_name/out")" = "Sign up to download Infinite: $GITHUB_URL" ] || fail "$case_name: unexpected output"
  [ ! -s "$test_root/$case_name/log" ] || fail "$case_name: invoked a command"
done

# A host that is not macOS gets the link printed (the page itself says Infinite is a Mac app).
run_installer linux INFINITE_INSTALL_INTERACTIVE=1 FAKE_OS=Linux
grep -Fxq "Sign up to download Infinite: $GITHUB_URL" "$test_root/linux/out" || fail "linux: link not printed"
[ ! -s "$test_root/linux/log" ] || fail "linux: invoked a command"

# Already installed: say so and open nothing (the npm wrapper then starts the bundled CLI).
mkdir -p "$test_root/installed/Applications/Infinite.app"
set +e
env PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/installed/log" INFINITE_APPLICATIONS_DIR="$test_root/installed/Applications" \
  INFINITE_INSTALL_INTERACTIVE=1 /bin/bash "$repo_root/scripts/install.sh" > "$test_root/installed/out" 2>&1
installed_status=$?
set -e
[ "$installed_status" = 0 ] || fail "installed: exit $installed_status"
grep -Fq "Infinite is already installed at $test_root/installed/Applications/Infinite.app" "$test_root/installed/out" || fail "installed: no notice"
[ ! -s "$test_root/installed/log" ] || fail "installed: invoked a command"

# --app-dir points the installed check elsewhere; a symlinked app is not treated as installed.
mkdir -p "$test_root/elsewhere/Infinite.app" "$test_root/linked/Applications"
ln -s "$test_root/elsewhere/Infinite.app" "$test_root/linked/Applications/Infinite.app"
run_installer app_dir INFINITE_INSTALL_INTERACTIVE=1 -- --app-dir "$test_root/elsewhere"
grep -Fq "already installed" "$test_root/app_dir/out" || fail "app_dir: --app-dir ignored"
set +e
env PATH="$fake_bin:/usr/bin:/bin" FAKE_LOG="$test_root/linked/log" INFINITE_APPLICATIONS_DIR="$test_root/linked/Applications" \
  INFINITE_INSTALL_INTERACTIVE=1 /bin/bash "$repo_root/scripts/install.sh" > "$test_root/linked/out" 2>&1
set -e
[ "$(cat "$test_root/linked/log")" = "open <$GITHUB_URL>" ] || fail "linked: a symlinked app counted as installed"

# Help and argument errors.
run_installer help -- --help
[ "$(status_of help)" = 0 ] || fail "help: exit $(status_of help)"
grep -Fq "Infinite for macOS installer" "$test_root/help/out" || fail "help: missing title"
grep -Fq "infinite.fast/get-started" "$test_root/help/out" || fail "help: does not name the sign-up page"
run_installer bad_option -- --bogus
[ "$(status_of bad_option)" = 2 ] || fail "bad_option: exit $(status_of bad_option)"
run_installer missing_dir -- --app-dir
[ "$(status_of missing_dir)" = 2 ] || fail "missing_dir: exit $(status_of missing_dir)"
for case_name in help bad_option missing_dir; do [ ! -s "$test_root/$case_name/log" ] || fail "$case_name: invoked a command"; done

printf 'install-smoke: ok\n'
