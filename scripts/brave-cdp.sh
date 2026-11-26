#!/usr/bin/env bash
# Start Brave with a local DevTools endpoint so the opencode-browser plugin can
# attach to the real browser instead of launching its own Chromium.
#
#   scripts/brave-cdp.sh [--port N] [--profile DIR]
#
# Chrome/Brave 136+ refuse --remote-debugging-port on the default profile, so
# this always uses a dedicated profile. Log into sites there once; cookies
# persist across runs.
set -euo pipefail

PORT="${BRAVE_CDP_PORT:-9222}"
PROFILE="${BRAVE_CDP_PROFILE:-$HOME/.config/opencode/brave-cdp-profile}"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --profile) PROFILE="${2:?--profile needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

endpoint="http://127.0.0.1:${PORT}/json/version"
if curl -sf --max-time 1 "$endpoint" >/dev/null 2>&1; then
  echo "DevTools already listening on 127.0.0.1:${PORT}"
  exit 0
fi

BIN=""
for candidate in brave-origin brave-browser brave; do
  if command -v "$candidate" >/dev/null 2>&1; then
    BIN="$(command -v "$candidate")"
    break
  fi
done
if [ -z "$BIN" ]; then
  echo "Brave not found (looked for brave-origin, brave-browser, brave)" >&2
  exit 1
fi

mkdir -p "$PROFILE"
BRAVE_ARGS=(
  --remote-debugging-port="$PORT"
  --user-data-dir="$PROFILE"
  --no-first-run
  --no-default-browser-check
  about:blank
)

# A transient systemd service keeps the browser out of the caller's cgroup, so
# restarting the editor/server does not take the browser (and its logins) down.
# Fall back to nohup where there is no user systemd instance.
env_args=()
add_env() {
  if [ -n "${2:-}" ]; then
    env_args+=(--setenv="$1=$2")
  fi
}
add_env DISPLAY "${DISPLAY:-}"
add_env WAYLAND_DISPLAY "${WAYLAND_DISPLAY:-}"
add_env XDG_RUNTIME_DIR "${XDG_RUNTIME_DIR:-}"
add_env XDG_SESSION_TYPE "${XDG_SESSION_TYPE:-}"
add_env DBUS_SESSION_BUS_ADDRESS "${DBUS_SESSION_BUS_ADDRESS:-}"

launched=0
if command -v systemd-run >/dev/null 2>&1; then
  if systemd-run --user --collect --quiet --unit="brave-cdp-${PORT}" \
    "${env_args[@]}" "$BIN" "${BRAVE_ARGS[@]}" >/dev/null 2>&1; then
    launched=1
  fi
fi
if [ "$launched" -eq 0 ]; then
  nohup "$BIN" "${BRAVE_ARGS[@]}" >/dev/null 2>&1 &
fi

for _ in $(seq 1 100); do
  if curl -sf --max-time 1 "$endpoint" >/dev/null 2>&1; then
    echo "Brave DevTools listening on 127.0.0.1:${PORT}"
    echo "Profile: $PROFILE"
    exit 0
  fi
  sleep 0.2
done

echo "Brave started but did not open 127.0.0.1:${PORT}." >&2
echo "If a Brave window already uses $PROFILE, close it and retry." >&2
exit 1
