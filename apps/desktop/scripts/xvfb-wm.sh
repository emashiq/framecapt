#!/usr/bin/env bash
# Runs a command on a private virtual X server (Xvfb, 1920x1080) with a window manager (openbox):
#   bash scripts/xvfb-wm.sh npm run test:e2e
# The e2e suite needs a window manager: without one, minimizing and window focus (and therefore the
# clipboard) do not work. Needs the xvfb and openbox packages. Used by CI and docs/building-on-linux.md.
set -euo pipefail
exec xvfb-run -a -s "-screen 0 1920x1080x24" bash -c 'openbox >/dev/null 2>&1 & sleep 1; exec "$@"' bash "$@"
