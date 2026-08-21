#!/usr/bin/env bash
# Tracy Brain daily loop runner.
# Runs Claude Code headlessly against loops/daily.md with scoped permissions.
#
# Manual run:   ./loops/run-daily.sh
# Cron (7am):   0 7 * * * /full/path/to/tracy-brain/loops/run-daily.sh >> /full/path/to/tracy-brain/loops/daily.log 2>&1
#
# Notes:
# - Tools are scoped tight on purpose. Bash is limited to the exact commands the
#   loop needs. Widen only if the loop starts failing on a missing permission.
# - --max-turns caps runaway runs. 60 is generous for a 5-concept day.
# - Headless runs use your normal Claude Code auth (subscription or API key).

set -euo pipefail
cd "$(dirname "$0")/.."

DATE=$(date +%Y-%m-%d)
echo "=== Tracy Brain loop: $DATE ==="

claude -p "$(cat loops/daily.md)" \
  --allowedTools "Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Bash(mv raw/*:*),Bash(node graph/build-graph.js),Bash(git add .),Bash(git commit:*),Bash(git status:*),Bash(date:*),Bash(ls:*)" \
  --permission-mode acceptEdits \
  --max-turns 60

echo "=== Loop complete: $DATE ==="
