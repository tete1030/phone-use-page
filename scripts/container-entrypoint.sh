#!/bin/sh
set -eu
umask 077
test -n "${CONSOLE_PASSWORD_FILE:-}" || { echo 'CONSOLE_PASSWORD_FILE is required' >&2; exit 1; }
test -r "$CONSOLE_PASSWORD_FILE" || { echo 'Password file is not readable by the container user' >&2; exit 1; }
mkdir -p /app/.local/auth /app/.local/tasks /home/node/.android
exec "$@"
