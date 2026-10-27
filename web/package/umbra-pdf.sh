#!/bin/sh
# Umbra PDF (desktop): starts the local server and opens the app in your browser. Ctrl+C stops it.
d="$(cd "$(dirname "$0")" && pwd)"
exec "$d/node/node" "$d/server.mjs" --root "$d/app" --models "$d/models" "$@"
