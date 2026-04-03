#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
set -a
. "$SCRIPT_DIR/.env.telemost"
set +a
export RECORDINGS_DIR="${RECORDINGS_DIR:-/opt/recordings/telemost}"
exec "$SCRIPT_DIR/start_meeting.sh" "$@"
