#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
set -a
. "$SCRIPT_DIR/.env.telemost"
set +a
exec "$SCRIPT_DIR/stop_meeting.sh"
