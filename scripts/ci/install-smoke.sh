#!/usr/bin/env bash
set -euo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
test_home="$(mktemp -d "${TMPDIR:-/tmp}/infinite-installer-home.XXXXXX")"
test_bin="$test_home/test-bin"
mkdir -p "$test_bin"
trap 'rm -rf "$test_home"' EXIT

ln -s "$(command -v node)" "$test_bin/node"
ln -s "$(command -v npm)" "$test_bin/npm"
clean_path="$test_bin:/usr/bin:/bin"

for required in git node npm; do
  if ! env PATH="$clean_path" sh -c "command -v $required" >/dev/null 2>&1; then
    printf 'clean test PATH is missing %s\n' "$required" >&2
    exit 1
  fi
done

if env PATH="$clean_path" sh -c 'command -v pnpm || command -v corepack' >/dev/null 2>&1; then
  printf 'clean test PATH unexpectedly contains pnpm or corepack\n' >&2
  exit 1
fi

# Seed an install whose origin is a bare repository containing this checkout as
# main. CI uses the committed PR checkout; local pre-commit runs also include
# tracked working-tree edits by applying the current diff into the seed clone.
source_checkout="$test_home/source-checkout"
source_remote="$test_home/source.git"
worktree_patch="$test_home/worktree.patch"
git clone "$repo_root" "$source_checkout" >/dev/null
git -C "$repo_root" diff --binary HEAD -- . > "$worktree_patch"
if [ -s "$worktree_patch" ]; then
  git -C "$source_checkout" apply "$worktree_patch"
fi
git -C "$source_checkout" add -A
if ! git -C "$source_checkout" diff --cached --quiet; then
  git -C "$source_checkout" \
    -c user.name="Infinite Installer Smoke" \
    -c user.email="installer-smoke@localhost" \
    commit -m "installer smoke checkout" >/dev/null
fi
git clone --bare "$source_checkout" "$source_remote" >/dev/null
git --git-dir="$source_remote" update-ref refs/heads/main "$(git -C "$source_checkout" rev-parse HEAD)"
git --git-dir="$source_remote" symbolic-ref HEAD refs/heads/main
git clone --branch main "$source_remote" "$test_home/.infinite/app" >/dev/null

env HOME="$test_home" SHELL=/bin/bash PATH="$clean_path" \
  bash "$repo_root/scripts/install.sh" --skip-setup

test -x "$test_home/.local/bin/infinite"
test -x "$test_home/.infinite/tooling/bin/pnpm"
test -d "$test_home/.infinite/app/.git"

version_output="$(env HOME="$test_home" PATH="$test_home/.local/bin:$clean_path" \
  GROWTH_OS_CLI_NONINTERACTIVE=1 infinite version 2>&1)"
case "$version_output" in
  *"Infinite OS "*) ;;
  *) printf 'unexpected version output: %s\n' "$version_output" >&2; exit 1 ;;
esac

non_tty_output="$(env HOME="$test_home" SHELL=/bin/bash PATH="$test_home/.local/bin:$clean_path" \
  bash "$repo_root/scripts/install.sh" </dev/null 2>&1)"
case "$non_tty_output" in
  *"No terminal detected, so setup was skipped."*) ;;
  *) printf '%s\n' "$non_tty_output" >&2; exit 1 ;;
esac

case "$non_tty_output" in
  *"/dev/tty: Device not configured"*)
    printf '%s\n' "$non_tty_output" >&2
    exit 1
    ;;
esac
