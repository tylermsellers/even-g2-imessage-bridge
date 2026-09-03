#!/bin/sh
# Functional MAP health check, used by docker-compose.yml's HEALTHCHECK.
#
# bt_status (see docker/bridge/src/index.js's /api/health) only reports
# adapter/bond state - it stays "ok" even when the actual MAP OBEX session
# has silently died (obexd logs repeated "Connection refused" / "Unable to
# find service record"), until tetherd is restarted. This is a known
# limitation: entrypoint.sh's own comment documents that tetherd only
# attempts the MAP session once at startup, with no automatic retry.
#
# bt_list_threads, by contrast, has to actually round-trip through obexd's
# live MAP session to answer at all - so a failure or timeout here is a
# much stronger real signal that the bond needs a fresh reconnect attempt
# (i.e. a container restart) than bt_status alone can ever give.
set -eu

SOCK="${TETHER_SOCKET:-/run/user/0/tether/tetherd.sock}"

RESP=$(printf '{"command":"bt_list_threads"}\n' | timeout 8 nc -U "$SOCK" 2>/dev/null | head -n1) || {
  echo "healthcheck: no response from tetherd on $SOCK" >&2
  exit 1
}

# Require at least one thread, not just a well-formed {"threads":[...]}
# response - confirmed by direct testing that killing obexd mid-session
# makes bt_list_threads return {"threads":[]} (no error), since tetherd
# still answers from BlueZ's cached folder listing even with a dead MAP
# transport. An empty array is therefore NOT a reliable "still healthy"
# signal on its own; grep for a real thread object's key fields instead.
case "$RESP" in
  *'"threads":[]'*)
    echo "healthcheck: bt_list_threads returned zero threads (MAP session likely dead): $RESP" >&2
    exit 1
    ;;
  *'"thread"'*)
    exit 0
    ;;
  *)
    echo "healthcheck: unexpected bt_list_threads response: $RESP" >&2
    exit 1
    ;;
esac
