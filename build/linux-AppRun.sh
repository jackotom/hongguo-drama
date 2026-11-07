#!/usr/bin/env bash
# Hongguo Drama 6.2 release candidate.
set -euo pipefail
# Keep Chromium sandboxing enabled; never silently add --no-sandbox on restricted systems.
APPDIR=${APPDIR:-$(dirname "$(readlink -f "$0")")}
export LD_LIBRARY_PATH="$APPDIR/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export XDG_DATA_DIRS="$APPDIR/usr/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
exec "$APPDIR/hongguo-drama" "$@"
