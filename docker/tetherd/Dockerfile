# Tether daemon (tetherd) - iMessage/SMS Bluetooth bridge
# Built against debian:unstable to match upstream's own CI (tether requires
# BlueZ >= 5.86 for full ANCS+MAP+PBAP mode; Debian stable/Ubuntu LTS ship
# older versions).
FROM debian:unstable AS build

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    g++ cmake ninja-build git pkg-config ca-certificates patch \
    libwayland-dev libavahi-client-dev libssl-dev libglib2.0-dev \
    libgtk-3-dev libgtk-layer-shell-dev libnotify-dev \
    npm zip gettext \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 https://github.com/zackb/tether.git .

# Limits the MAP inbox/sent backfill+poll to the last 30 days, enforced by
# the phone itself via BlueZ's MAP PeriodBegin filter (not a local
# post-filter) - see tether-patch/README.md for the full rationale.
COPY tether-patch /tmp/tether-patch
RUN sh /tmp/tether-patch/apply.sh

# Headless build: we only need tetherd + tether CLI, not tether-gtk, but the
# project's single CMakeLists builds everything together. BLUETOOTHD_PATH is
# detected at configure time from this image's actual bluetoothd location.
RUN cmake --preset release -DBLUETOOTHD_PATH=/usr/libexec/bluetooth/bluetoothd \
    && cmake --build --preset release

# -----------------------------------------------------------------------------
FROM debian:unstable

ENV DEBIAN_FRONTEND=noninteractive

# Runtime deps: bluez (bluetoothd + obexd + btmgmt), dbus (system bus),
# avahi (mDNS, used by tetherd's discovery), openssl (TLS certs).
# evolution-data-server backs obexd's PBAP (contacts) registry — without it
# obexd's obex_server_init fails outright and MAP (messages) never comes up
# either, since both profiles share the same obexd process.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bluez bluez-obexd dbus avahi-daemon openssl libavahi-client3 \
    libwayland-client0 libnotify4 libglib2.0-0 ca-certificates \
    evolution-data-server \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/build/release/tether /usr/bin/tether
COPY --from=build /src/build/release/tetherd /usr/bin/tetherd

# Patched obexd (bluez 5.87-2, matches the apt-installed bluez-obexd version
# above as of this writing): upstream obexd gates its Bluetooth transport
# driver registration behind systemd-logind reporting an "active" login
# session (obexd/src/logind.c logind_register() -> sd_uid_get_state() /
# sd_uid_get_seats()). This container has no real systemd/logind, so that
# condition is never satisfied and obexd crash-loops forever with
# "obex_server_init failed: No transport driver registered" - MAP/PBAP can
# never come up. logind_register() is patched to just call init_cb(TRUE)
# immediately, skipping the meaningless-in-a-container login-session check.
# See obexd-patch/logind.c.patched for the full patched source and
# obexd-patch/README.md for the rebuild recipe if bluez's version changes.
COPY obexd-patch/obexd /usr/libexec/bluetooth/obexd
# COPY does not preserve the executable bit from a Windows-copied source
# file, so it must be set explicitly or entrypoint.sh's `obexd -n &` fails
# with "permission denied" and MAP/PBAP silently never come up.
RUN chmod +x /usr/libexec/bluetooth/obexd

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 5134

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
