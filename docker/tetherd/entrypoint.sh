#!/bin/bash
# Container entrypoint that replicates, by hand, the systemd units tether's
# docs (docs/BLUETOOTH.md) says are required — this image has no systemd, so
# there is no bluetooth.service.d drop-in or tether-btclass@hci0 template unit.
set -eu

log() { echo "[entrypoint] $*"; }

cleanup() {
    log "shutting down..."
    [ -n "${TETHERD_PID:-}" ] && kill "$TETHERD_PID" 2>/dev/null || true
    [ -n "${OBEXD_PID:-}" ] && kill "$OBEXD_PID" 2>/dev/null || true
    [ -n "${BLUETOOTHD_PID:-}" ] && kill "$BLUETOOTHD_PID" 2>/dev/null || true
    [ -n "${DBUS_PID:-}" ] && kill "$DBUS_PID" 2>/dev/null || true
}
trap cleanup TERM INT

# --- XDG runtime dir --------------------------------------------------------
# tetherd refuses to start without this (normally set up by a systemd/pam
# user session); obexd's session-bus autolaunch also expects it to exist.
export XDG_RUNTIME_DIR=/run/user/0
mkdir -p "$XDG_RUNTIME_DIR"
chmod 0700 "$XDG_RUNTIME_DIR"

# --- D-Bus system bus -------------------------------------------------------
mkdir -p /var/run/dbus
[ -f /etc/machine-id ] || dbus-uuidgen --ensure=/etc/machine-id
rm -f /var/run/dbus/pid
dbus-daemon --system --fork --print-pid > /tmp/dbus.pid
DBUS_PID=$(cat /tmp/dbus.pid)
log "dbus-daemon started (pid $DBUS_PID)"
sleep 1

# --- D-Bus session bus ------------------------------------------------------
# obexd is normally a per-user session service activated over the session
# bus; there is no login session here, so start one by hand and export its
# address so obexd's dbus_bus_get(DBUS_BUS_SESSION) succeeds instead of
# trying (and failing) to X11-autolaunch one.
export DBUS_SESSION_BUS_ADDRESS=$(dbus-daemon --session --fork --print-address)
log "session dbus-daemon started, address $DBUS_SESSION_BUS_ADDRESS"

# --- avahi-daemon (mDNS, used by tetherd's local discovery) -----------------
mkdir -p /var/run/avahi-daemon
chown avahi:avahi /var/run/avahi-daemon 2>/dev/null || true
avahi-daemon --daemonize --no-chroot
log "avahi-daemon started"

# --- bluetoothd, with the experimental bearer API -----------------------------
# This is the manual equivalent of packaging/systemd/bluetooth-experimental.conf.in
BLUETOOTHD_BIN=$(command -v bluetoothd || echo /usr/libexec/bluetooth/bluetoothd)
"$BLUETOOTHD_BIN" --experimental --nodetach &
BLUETOOTHD_PID=$!
log "bluetoothd started (pid $BLUETOOTHD_PID) via $BLUETOOTHD_BIN --experimental"

# Wait for hci0 to be registered with BlueZ over D-Bus (bluetoothctl list)
for i in $(seq 1 20); do
    if bluetoothctl list 2>/dev/null | grep -q "Controller"; then
        break
    fi
    sleep 0.5
done

# --- Class of Device = A/V Hands-Free (major 4, minor 8) --------------------
# Manual equivalent of tether-btclass@hci0.service; retried for ~10s since
# hci0 may not be immediately ready for btmgmt after bluetoothd starts.
for i in $(seq 1 20); do
    if btmgmt --index hci0 class 4 8 2>/dev/null; then
        log "class of device set to 4 8 (A/V Hands-Free)"
        break
    fi
    sleep 0.5
done
# --- obexd (MAP/PBAP transport, normally a socket-activated user service) --
OBEXD_BIN=$(command -v obexd || echo /usr/libexec/bluetooth/obexd)
if [ -x "$OBEXD_BIN" ]; then
    "$OBEXD_BIN" -n &
    OBEXD_PID=$!
    log "obexd started (pid $OBEXD_PID) via $OBEXD_BIN"

    # Wait for obexd to actually register org.bluez.obex on the session bus
    # before starting tetherd. Without this, tetherd starts immediately and
    # can make its one and only startup MAP-session attempt before obexd's
    # D-Bus name is up, gets a timeout, and never retries - MAP/PBAP then
    # never comes up until the container is manually restarted.
    for i in $(seq 1 20); do
        if dbus-send --session --dest=org.freedesktop.DBus --type=method_call \
            --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null \
            | grep -q "org.bluez.obex"; then
            log "org.bluez.obex is registered on the session bus"
            break
        fi
        sleep 0.5
    done
else
    log "warning: obexd binary not found at expected path, MAP/PBAP will not work"
fi

# --- tetherd itself, in the foreground so container lifecycle == daemon's --
log "starting tetherd (TCP 5134 + local control socket)"
tetherd &
TETHERD_PID=$!

wait "$TETHERD_PID"
