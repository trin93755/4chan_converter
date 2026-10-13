#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "4chan gem converter needs Node.js 22 or newer: https://nodejs.org"
  exit 1
fi
if [ -x "$PWD/bin/ffmpeg" ]; then export FFMPEG_PATH="$PWD/bin/ffmpeg"; fi
if [ -x "$PWD/bin/ffprobe" ]; then export FFPROBE_PATH="$PWD/bin/ffprobe"; fi
exec node server.mjs
