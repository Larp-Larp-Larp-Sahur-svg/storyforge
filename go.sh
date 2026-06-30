#!/usr/bin/env bash
# ============================================================================
#  StoryForge — ONE-SHOT bootstrapper
#  Drop this file next to the StoryForge .zip and run:  bash go.sh
#
#  It will, in order:
#    1) FIND the StoryForge zip in this folder (or take a path/URL arg)
#    2) EXTRACT it
#    3) Locate the app root (where index.html lives) + scan/verify files
#    4) SERVE it on http://localhost:PORT (background, opens browser)
#    5) PUSH it to GitHub  (git init/commit/push — never --force)
#    6) DEPLOY it to Cloudflare Pages via Wrangler
#
#  Usage:
#    bash go.sh                                   # fully interactive
#    bash go.sh --repo <git-url> --project <name> # non-interactive
#    bash go.sh ./storyforge.zip --repo <git-url>
#  Flags:
#    --repo <url>      GitHub remote (https or ssh). Prompted if omitted.
#    --project <name>  Cloudflare Pages project name (default: storyforge)
#    --port <n>        Local server port (default: 8787)
#    --no-serve        Skip the local server step
#    --no-push         Skip the GitHub push step
#    --no-deploy       Skip the Cloudflare deploy step
#    --yes             Assume yes / non-interactive (skips optional prompts)
# ============================================================================
set -euo pipefail

BLUE='\033[1;34m'; GRN='\033[1;32m'; YEL='\033[1;33m'; RED='\033[1;31m'; DIM='\033[2m'; NC='\033[0m'
say(){ echo -e "${BLUE}→${NC} $*"; }
ok(){ echo -e "${GRN}✓${NC} $*"; }
warn(){ echo -e "${YEL}⚠${NC} $*"; }
err(){ echo -e "${RED}✗${NC} $*" >&2; }
step(){ echo -e "\n${BLUE}━━━ $* ━━━${NC}"; }

# ---- defaults + arg parsing ----
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIP_ARG=""; REPO=""; PROJECT="storyforge"; PORT="8787"
DO_SERVE=1; DO_PUSH=1; DO_DEPLOY=1; ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2;;
    --project) PROJECT="${2:-storyforge}"; shift 2;;
    --port) PORT="${2:-8787}"; shift 2;;
    --no-serve) DO_SERVE=0; shift;;
    --no-push) DO_PUSH=0; shift;;
    --no-deploy) DO_DEPLOY=0; shift;;
    --yes|-y) ASSUME_YES=1; shift;;
    -h|--help) sed -n '2,40p' "$0"; exit 0;;
    *.zip) ZIP_ARG="$1"; shift;;
    http*://*) ZIP_ARG="$1"; shift;;
    *) warn "ignoring unknown arg: $1"; shift;;
  esac
done
ask(){ # ask <prompt> <default> ; respects --yes
  local p="$1" d="${2:-}" a
  if [ "$ASSUME_YES" = "1" ]; then echo "$d"; return; fi
  read -r -p "$(echo -e "${BLUE}?${NC} $p")" a </dev/tty || true
  echo "${a:-$d}"
}

step "1 · FIND the StoryForge zip"
ZIP=""
if [ -n "$ZIP_ARG" ]; then
  if [[ "$ZIP_ARG" == http*://* ]]; then
    say "Downloading $ZIP_ARG"
    ZIP="$HERE/_storyforge_dl.zip"
    curl -fsSL "$ZIP_ARG" -o "$ZIP" || { err "download failed"; exit 1; }
  else
    ZIP="$(cd "$(dirname "$ZIP_ARG")" && pwd)/$(basename "$ZIP_ARG")"
  fi
else
  # newest storyforge*.zip first, else any *.zip that contains index.html
  ZIP="$(ls -t "$HERE"/storyforge*.zip 2>/dev/null | head -n1 || true)"
  if [ -z "$ZIP" ]; then
    for z in "$HERE"/*.zip; do
      [ -e "$z" ] || continue
      if unzip -l "$z" 2>/dev/null | grep -q 'index.html'; then ZIP="$z"; break; fi
    done
  fi
fi
[ -n "$ZIP" ] && [ -f "$ZIP" ] || { err "No StoryForge .zip found in $HERE (pass one: bash go.sh ./file.zip)"; exit 1; }
ok "Found zip: $(basename "$ZIP")  ($(du -h "$ZIP" | cut -f1))"

step "2 · EXTRACT"
DEST="$HERE/storyforge"
if [ -d "$DEST" ] && [ "$ASSUME_YES" != "1" ]; then
  if [ "$(ask "Folder 'storyforge' exists. Overwrite? [y/N] " "n")" != "y" ]; then DEST="$HERE/storyforge_$(date +%s)"; fi
fi
mkdir -p "$DEST"
unzip -o "$ZIP" -d "$DEST" >/dev/null
ok "Extracted to: $DEST"

step "3 · LOCATE app root + verify"
APP="$(dirname "$(find "$DEST" -maxdepth 3 -name index.html | head -n1)")"
[ -n "$APP" ] && [ -f "$APP/index.html" ] || { err "index.html not found inside the zip"; exit 1; }
cd "$APP"
ok "App root: $APP"
if command -v tree >/dev/null 2>&1; then tree -L 2 -I 'node_modules|.git'; else find . -maxdepth 2 -not -path '*/node_modules/*' | sed 's|^\./||' | sort; fi
for req in index.html manifest.webmanifest sw.js js/app.js js/engine.js; do
  [ -f "$req" ] && ok "verified $req" || warn "missing $req"
done

if [ "$DO_SERVE" = "1" ]; then
  step "4 · SERVE on http://localhost:$PORT"
  if command -v python3 >/dev/null 2>&1; then SRV=(python3 -m http.server "$PORT");
  elif command -v npx >/dev/null 2>&1; then SRV=(npx --yes serve -l "$PORT" .);
  else SRV=(); warn "no python3/npx to serve"; fi
  if [ "${#SRV[@]}" -gt 0 ]; then
    "${SRV[@]}" >/tmp/storyforge_srv.log 2>&1 &
    SRV_PID=$!
    sleep 1
    (command -v xdg-open >/dev/null && xdg-open "http://localhost:$PORT" >/dev/null 2>&1) || \
    (command -v open >/dev/null && open "http://localhost:$PORT" >/dev/null 2>&1) || true
    ok "Serving (pid $SRV_PID). Logs: /tmp/storyforge_srv.log"
  fi
fi

if [ "$DO_PUSH" = "1" ]; then
  step "5 · PUSH to GitHub"
  if ! command -v git >/dev/null 2>&1; then
    warn "git not installed — skipping push"
  else
    [ -z "$REPO" ] && REPO="$(ask 'GitHub remote URL (blank to skip): ' '')"
    if [ -z "$REPO" ]; then
      warn "No repo URL — skipping push"
    else
      [ -d .git ] || { git init -q; ok 'git initialized'; }
      [ -f .gitignore ] || printf 'node_modules/\n.DS_Store\n*.zip\n.wrangler/\n_storyforge_dl.zip\n' > .gitignore
      git add -A
      git -c user.email="storyforge@local" -c user.name="StoryForge" commit -q -m "StoryForge build $(date +%Y-%m-%d_%H:%M)" || warn 'nothing new to commit'
      if git remote | grep -q '^origin$'; then git remote set-url origin "$REPO"; else git remote add origin "$REPO"; fi
      git branch -M main
      say "Pushing to $REPO (no --force)"
      if git push -u origin main; then ok 'pushed to GitHub'; else err 'push failed (check credentials / repo URL)'; fi
    fi
  fi
fi

if [ "$DO_DEPLOY" = "1" ]; then
  step "6 · DEPLOY to Cloudflare Pages"
  if ! command -v npx >/dev/null 2>&1; then
    warn "npx (Node) not found — skipping Cloudflare deploy"
  else
    if [ "$ASSUME_YES" = "1" ] || [ "$(ask "Deploy to Cloudflare Pages project '$PROJECT'? [Y/n] " 'y')" != "n" ]; then
      say "wrangler pages deploy . --project-name $PROJECT"
      if npx --yes wrangler@latest pages deploy . --project-name "$PROJECT" --commit-dirty=true; then
        ok 'deployed to Cloudflare Pages'
      else
        err 'deploy failed (run: npx wrangler login, then re-run)'
      fi
    else
      warn 'skipped Cloudflare deploy'
    fi
  fi
fi

echo
ok "DONE."
if [ "${DO_SERVE:-0}" = "1" ] && [ -n "${SRV_PID:-}" ]; then
  echo -e "${DIM}Local server still running at http://localhost:$PORT (pid ${SRV_PID}). Stop it with: kill ${SRV_PID}${NC}"
  wait "$SRV_PID"
fi
