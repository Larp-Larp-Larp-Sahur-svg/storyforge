#!/usr/bin/env bash
# ============================================================================
#  StoryForge — ALL-IN-ONE command
#  Scans your dir -> unzips any bundle -> serves on localhost -> (optional)
#  pushes to GitHub -> deploys to Cloudflare Pages via Wrangler.
#
#  Usage:
#    ./forge.sh                 # scan + unzip + run local server (default)
#    ./forge.sh run             # just serve locally on :8787
#    ./forge.sh github <repo>   # init/commit/push to a GitHub repo URL
#    ./forge.sh deploy [name]   # deploy to Cloudflare Pages (default: storyforge)
#    ./forge.sh all <repo> [cf] # do EVERYTHING in sequence
# ============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
PORT="${PORT:-8787}"
PROJECT="${2:-storyforge}"
BLUE='\033[1;34m'; GRN='\033[1;32m'; YEL='\033[1;33m'; RED='\033[1;31m'; NC='\033[0m'
say(){ echo -e "${BLUE}→${NC} $*"; }
ok(){ echo -e "${GRN}✓${NC} $*"; }
warn(){ echo -e "${YEL}⚠${NC} $*"; }

scan_dir(){
  say "Scanning project directory: $DIR"
  if command -v tree >/dev/null 2>&1; then tree -L 2 -I 'node_modules|.git'; else find . -maxdepth 2 -not -path '*/node_modules/*' -not -path '*/.git/*' | sed 's|^\./||' | sort; fi
  echo
  for req in index.html manifest.webmanifest sw.js js/app.js; do
    [ -f "$req" ] && ok "found $req" || warn "missing $req"
  done
}

unzip_bundles(){
  shopt -s nullglob
  for z in *.zip; do
    say "Unzipping $z"
    unzip -o "$z" -d . >/dev/null && ok "unpacked $z"
  done
  shopt -u nullglob
}

serve(){
  say "Serving on http://localhost:$PORT  (Ctrl+C to stop)"
  if command -v python3 >/dev/null 2>&1; then
    ( sleep 1; (command -v xdg-open >/dev/null && xdg-open "http://localhost:$PORT") || (command -v open >/dev/null && open "http://localhost:$PORT") || true ) &
    exec python3 -m http.server "$PORT"
  elif command -v npx >/dev/null 2>&1; then
    exec npx --yes serve -l "$PORT" .
  else
    warn "No python3 or npx found to serve."; exit 1
  fi
}

push_github(){
  local repo="${1:-}"
  [ -z "$repo" ] && { warn "Usage: ./forge.sh github <git-remote-url>"; exit 1; }
  command -v git >/dev/null || { warn "git not installed"; exit 1; }
  [ -d .git ] || { git init -q; ok "git initialized"; }
  [ -f .gitignore ] || printf 'node_modules/\n.DS_Store\n*.zip\n.wrangler/\n' > .gitignore
  git add -A
  git commit -q -m "StoryForge build $(date +%Y-%m-%d_%H:%M)" || warn "nothing to commit"
  if git remote | grep -q origin; then git remote set-url origin "$repo"; else git remote add origin "$repo"; fi
  git branch -M main
  say "Pushing to $repo"
  git push -u origin main   # NOTE: no --force, per safe-deploy policy
  ok "pushed to GitHub"
}

deploy_cf(){
  local name="${1:-storyforge}"
  command -v npx >/dev/null || { warn "npx (Node) required for wrangler"; exit 1; }
  say "Deploying to Cloudflare Pages project: $name"
  # Static site = current dir. Wrangler will prompt to log in the first time.
  npx --yes wrangler@latest pages deploy . --project-name "$name" --commit-dirty=true
  ok "deployed to Cloudflare Pages"
}

case "${1:-default}" in
  default) scan_dir; unzip_bundles; serve ;;
  scan)    scan_dir ;;
  run)     serve ;;
  github)  push_github "${2:-}" ;;
  deploy)  deploy_cf "${2:-storyforge}" ;;
  all)     scan_dir; unzip_bundles; push_github "${2:-}"; deploy_cf "${3:-storyforge}"; ok "ALL DONE" ;;
  *) echo "Usage: ./forge.sh [scan|run|github <repo>|deploy <name>|all <repo> <name>]"; exit 1 ;;
esac
