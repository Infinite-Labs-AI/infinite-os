#!/usr/bin/env bash
# ============================================================================
# Infinite Installer
# ============================================================================
# One-line install for macOS and Linux:
#
#   curl -fsSL https://raw.githubusercontent.com/Infinite-Labs-AI/infinite-os/main/scripts/install.sh | bash
#
# What it does:
#   1. Checks prerequisites (git, Node >= 20, pnpm). It does NOT install or
#      upgrade them for you — if something is missing it prints how to get it
#      and stops.
#   2. Clones (or updates) Infinite into a fixed home: ~/.infinite/app
#   3. Drops a small `infinite` launcher on your PATH (~/.local/bin/infinite)
#      so you can run `infinite` from anywhere.
#   4. Runs `infinite setup`. The first run self-installs workspace deps and
#      builds the CLI (you'll see the build progress bar), then configures
#      Infinite — so there is no separate build step here.
#
# It puts a small `infinite` wrapper on the PATH (+ a shell-rc PATH line) so the
# CLI runs from anywhere, backed by Infinite's Node/pnpm workspace.
#
# Options:
#   --dir PATH      Install location (default: ~/.infinite/app, or $INFINITE_DIR)
#   --branch NAME   Git branch to install (default: main)
#   --skip-setup    Don't run `infinite setup` at the end
#   -h, --help      Show this help
# ============================================================================

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
log_info()    { printf "${CYAN}→${NC} %s\n" "$1"; }
log_success() { printf "${GREEN}✓${NC} %s\n" "$1"; }
log_warn()    { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
log_error()   { printf "${RED}✗${NC} %s\n" "$1" >&2; }

# ── Configuration ─────────────────────────────────────────────────────────────
REPO_URL_SSH="git@github.com:Infinite-Labs-AI/infinite-os.git"
REPO_URL_HTTPS="https://github.com/Infinite-Labs-AI/infinite-os.git"
INSTALL_DIR="${INFINITE_DIR:-$HOME/.infinite/app}"
COMMAND_LINK_DIR="$HOME/.local/bin"
BRANCH="main"
RUN_SETUP=true
MIN_NODE_MAJOR=20

# A piped `curl | bash` has no terminal on stdin. We still want the interactive
# `infinite setup` to work, so detect whether a controlling terminal exists.
if [ -t 0 ]; then
  HAS_TTY=true
elif [ -r /dev/tty ]; then
  HAS_TTY=true
else
  HAS_TTY=false
fi

# ── Argument parsing ──────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      [ $# -ge 2 ] || { log_error "--dir requires a path argument"; exit 1; }
      INSTALL_DIR="$2"; shift 2 ;;
    --branch)
      [ $# -ge 2 ] || { log_error "--branch requires a branch name"; exit 1; }
      BRANCH="$2"; shift 2 ;;
    --skip-setup) RUN_SETUP=false; shift ;;
    -h|--help)
      # When run from a file, print the header comment. Under `curl | bash -s -- --help`
      # $0 is "bash" (not this script), so fall back to a short usage string instead
      # of sed'ing the bash binary to stdout.
      if [ -f "$0" ]; then
        sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'
      else
        printf 'Infinite installer\n\n'
        printf 'Usage: install.sh [--dir PATH] [--branch NAME] [--skip-setup] [-h|--help]\n'
        printf 'Installs Infinite to ~/.infinite/app, puts `infinite` on your PATH, then runs `infinite setup`.\n'
      fi
      exit 0 ;;
    *) log_error "Unknown option: $1"; exit 1 ;;
  esac
done

printf "\n${BOLD}${CYAN}Infinite installer${NC}\n\n"

# ── 1. Prerequisites (check only — never install or upgrade) ──────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macOS" ;;
  Linux)  PLATFORM="Linux" ;;
  *) log_warn "Unrecognized OS '$OS' — this installer targets macOS and Linux. Continuing anyway." ; PLATFORM="$OS" ;;
esac
log_success "Platform: $PLATFORM"

missing=0

if command -v git >/dev/null 2>&1; then
  log_success "git found ($(git --version | awk '{print $3}'))"
else
  log_error "git is required but not found."
  case "$OS" in
    Darwin) log_info "Install it with:  xcode-select --install   (or: brew install git)" ;;
    *)      log_info "Install git with your package manager, e.g.:  sudo apt install git" ;;
  esac
  missing=1
fi

if command -v node >/dev/null 2>&1; then
  NODE_RAW="$(node -v 2>/dev/null || true)"  # e.g. v20.11.1 (|| true so a broken `node -v` can't abort us under set -e)
  NODE_MAJOR="${NODE_RAW#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
  case "$NODE_MAJOR" in
    ''|*[!0-9]*) log_warn "Could not parse Node version '$NODE_RAW' — assuming it's fine." ;;
    *)
      if [ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ]; then
        log_success "Node $NODE_RAW found (>= $MIN_NODE_MAJOR)"
      else
        log_error "Node $NODE_RAW is too old — Infinite needs Node >= $MIN_NODE_MAJOR."
        log_info "Upgrade Node from https://nodejs.org/ (LTS), or via nvm:  nvm install --lts"
        missing=1
      fi ;;
  esac
else
  log_error "Node.js >= $MIN_NODE_MAJOR is required but not found."
  log_info "Install the LTS from https://nodejs.org/ — or:  brew install node   (macOS)"
  missing=1
fi

if command -v pnpm >/dev/null 2>&1; then
  log_success "pnpm found ($(pnpm --version 2>/dev/null))"
else
  log_error "pnpm is required but not found."
  log_info "Enable it (ships with Node 16.13+):  corepack enable pnpm"
  log_info "Or install it directly:              npm install -g pnpm"
  missing=1
fi

if [ "$missing" -ne 0 ]; then
  printf "\n"
  log_error "Missing prerequisites (see above). Install them, then re-run this installer."
  exit 1
fi

# ── 2. Clone or update the repo into a fixed home ─────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  log_info "Existing install at $INSTALL_DIR — updating…"
  if [ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]; then
    log_warn "Local changes detected in $INSTALL_DIR — leaving them as-is and skipping update."
  else
    git -C "$INSTALL_DIR" fetch origin
    # Check out the branch; create a local tracking branch if it only exists on origin.
    git -C "$INSTALL_DIR" checkout "$BRANCH" 2>/dev/null \
      || git -C "$INSTALL_DIR" checkout -b "$BRANCH" "origin/$BRANCH"
    # Non-fatal: on a re-run where the local branch has diverged, --ff-only fails;
    # warn and keep the existing checkout instead of aborting with a raw git error.
    if git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"; then
      log_success "Updated to latest $BRANCH"
    else
      log_warn "Could not fast-forward $BRANCH (local commits or divergence) — leaving the checkout as-is."
    fi
  fi
elif [ -e "$INSTALL_DIR" ]; then
  log_error "$INSTALL_DIR exists but is not a git checkout. Remove it or pass --dir PATH."
  exit 1
else
  log_info "Installing into ${INSTALL_DIR}…"   # brace: a bare $INSTALL_DIR abutting the multibyte … folds a byte into the name in some locales (set -u abort)
  mkdir -p "$(dirname "$INSTALL_DIR")"
  # Prefer SSH (works for private access); fall back to HTTPS. BatchMode + a
  # short timeout makes SSH fail fast instead of hanging on a missing key.
  if GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=5" \
       git clone --branch "$BRANCH" "$REPO_URL_SSH" "$INSTALL_DIR" 2>/dev/null; then
    log_success "Cloned via SSH"
  else
    rm -rf "$INSTALL_DIR"   # clean up any partial SSH clone
    log_info "SSH unavailable — cloning via HTTPS…"
    git clone --branch "$BRANCH" "$REPO_URL_HTTPS" "$INSTALL_DIR"
    log_success "Cloned via HTTPS"
  fi
fi

# ── 2b. Fetch the GA4 quick-connect OAuth client (best-effort) ─────────────────
# Non-confidential installed-app OAuth client distributed OUT-OF-BAND as a release
# asset — deliberately NOT in the git tree (the public-surface tripwire forbids it).
# Best-effort and silent-fail: a missing/unreachable asset must NEVER block install;
# the founder just falls back to the guided bring-your-own flow. The asset does not
# exist until flip day, so this is expected to no-op today.
GA4_CLIENT_URL="https://github.com/Infinite-Labs-AI/infinite-os/releases/latest/download/ga4-oauth-client.json"
GA4_CLIENT_DEST="$INSTALL_DIR/ga4-oauth-client.json"
if command -v curl >/dev/null 2>&1; then
  if curl -fsSL "$GA4_CLIENT_URL" -o "$GA4_CLIENT_DEST" 2>/dev/null; then
    log_success "Fetched GA4 quick-connect client"
  else
    rm -f "$GA4_CLIENT_DEST" 2>/dev/null || true   # drop any empty/partial file
    log_info "No GA4 quick-connect client available — guided bring-your-own setup will be used."
  fi
elif command -v wget >/dev/null 2>&1; then
  if wget -qO "$GA4_CLIENT_DEST" "$GA4_CLIENT_URL" 2>/dev/null; then
    log_success "Fetched GA4 quick-connect client"
  else
    rm -f "$GA4_CLIENT_DEST" 2>/dev/null || true
    log_info "No GA4 quick-connect client available — guided bring-your-own setup will be used."
  fi
else
  log_info "Neither curl nor wget found — guided bring-your-own GA4 setup will be used."
fi

# ── 3. Put `infinite` on the PATH ─────────────────────────────────────────────
# A WRAPPER, not a symlink: the ./infinite launcher resolves its repo via
# `dirname "$0"` without following symlinks, so a symlink would point it at the
# wrong directory. Exec'ing the absolute path keeps $0 correct.
mkdir -p "$COMMAND_LINK_DIR"
cat > "$COMMAND_LINK_DIR/infinite" <<EOF
#!/usr/bin/env bash
# Infinite launcher shim — installed by scripts/install.sh.
# Runs Infinite from anywhere by handing off to the checkout below.
# If you move the repo, update this path.
exec "$INSTALL_DIR/infinite" "\$@"
EOF
chmod +x "$COMMAND_LINK_DIR/infinite"
log_success "Installed launcher → $COMMAND_LINK_DIR/infinite"

# Ensure ~/.local/bin is on PATH. Add a line to the right shell rc only if it's
# missing, then export for this session so `infinite` works immediately.
ensure_on_path() {
  case ":$PATH:" in
    *":$COMMAND_LINK_DIR:"*) log_success "$COMMAND_LINK_DIR already on PATH"; return ;;
  esac

  added=false
  login_shell="$(basename "${SHELL:-/bin/bash}")"
  path_line='export PATH="$HOME/.local/bin:$PATH"'
  comment='# Infinite — ensure ~/.local/bin is on PATH'

  add_line_to() {
    rc="$1"
    [ -n "$rc" ] || return
    touch "$rc" 2>/dev/null || return
    if ! grep -v '^[[:space:]]*#' "$rc" 2>/dev/null | grep -q '\.local/bin'; then
      printf '\n%s\n%s\n' "$comment" "$path_line" >> "$rc"
      log_success "Added ~/.local/bin to PATH in $rc"
    fi
    added=true
  }

  case "$login_shell" in
    zsh)  add_line_to "$HOME/.zshrc" ;;
    bash) add_line_to "$HOME/.bashrc"; [ -f "$HOME/.bash_profile" ] && add_line_to "$HOME/.bash_profile" ;;
    fish)
      fish_config="$HOME/.config/fish/config.fish"
      mkdir -p "$(dirname "$fish_config")"; touch "$fish_config"
      if ! grep -q 'fish_add_path.*\.local/bin' "$fish_config" 2>/dev/null; then
        printf '\n%s\nfish_add_path "$HOME/.local/bin"\n' "$comment" >> "$fish_config"
        log_success "Added ~/.local/bin to PATH in $fish_config"
      fi
      added=true ;;
    *)    add_line_to "$HOME/.profile" ;;
  esac

  if [ "$added" != true ]; then
    log_warn "Could not update a shell config automatically."
    log_info "Add this to your shell profile:  $path_line"
  fi
  export PATH="$COMMAND_LINK_DIR:$PATH"
}
ensure_on_path

# ── 4. Configure (first run self-installs deps + builds, then sets up) ────────
printf "\n"
if [ "$RUN_SETUP" != true ]; then
  log_success "Install complete."
  log_info "Next:  infinite setup    (the first run builds the CLI, then configures Infinite)"
  exit 0
fi

if [ "$HAS_TTY" = true ]; then
  log_info "Running 'infinite setup' (first run builds the CLI — this can take ~20-30s)…"
  printf "\n"
  if [ -t 0 ]; then
    "$INSTALL_DIR/infinite" setup
  else
    "$INSTALL_DIR/infinite" setup < /dev/tty
  fi
else
  log_success "Install complete."
  log_info "No terminal detected, so setup was skipped."
  log_info "Open a new terminal and run:  infinite setup"
fi
