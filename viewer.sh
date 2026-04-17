#!/usr/bin/env bash
# Open the browser (macOS) then launch the Deno server.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${LOOM_VIEWER_PORT:-7733}"
(sleep 0.8 && open "http://localhost:${PORT}") &
exec deno task --cwd "$DIR" viewer
