# Patched `obexd` (bluez 5.87-2)

## Why this exists

Upstream `obexd` gates registration of its Bluetooth transport driver behind
systemd-logind reporting an "active" login session for the current UID
(`obexd/src/logind.c: logind_register()` -> `sd_uid_get_state()` /
`sd_uid_get_seats(uid, 1, NULL)`). This container has no real systemd/logind
(`System has not been booted with systemd as init system`), so that
condition can never be satisfied and the callback that registers the
Bluetooth transport driver (`bluetooth_init_cb()` in
`obexd/plugins/bluetooth.c`) is silently never invoked.

Symptom: `obexd` starts, loads all its plugins successfully (you'll see
"Plugin bluetooth loaded" etc. in its debug log), but then fails with:

```
obexd/src/server.c:obex_server_init() No transport driver registered
obex_server_init failed
```

...and gets endlessly restarted by D-Bus service activation (`org.bluez.obex`)
within ~1 second, forever. `tetherd` sees this as MAP/PBAP session opens that
always time out.

Two things that do NOT fix this (tried and rejected):
- Faking `/run/systemd/{users,sessions,seats}/*` files to trick
  `sd_uid_get_state()`/`sd_uid_get_seats()` into reporting an active
  session — fragile, version-dependent, and we couldn't get
  `sd_uid_get_seats(uid, 1, NULL)` to return a nonzero seat count no matter
  what file contents we tried.
- Running `obexd --system-bus` — this does disable the logind gate (main.c
  calls `logind_set(FALSE)` when `--system-bus` is passed), but it *also*
  moves obexd's own control API (`org.bluez.obex`, used by `tetherd` to open
  MAP/PBAP sessions) from the session bus to the system bus. `tetherd`
  expects `org.bluez.obex` on the session bus (matching Tether's own docs:
  "`obexd` must be running (user service `obex`)"), so this breaks `tetherd`
  with `no_daemon` even though obexd itself is stable.

## The fix

One function, `obexd/src/logind.c: logind_register()`, is patched to just
call `init_cb(TRUE)` unconditionally at the very top, before any of the
systemd-logind session-state checking:

```c
int logind_register(logind_init_cb init_cb, logind_exit_cb exit_cb)
{
	struct callback_pair *cbs;

	/* Container/headless patch: no real systemd-logind session tracking
	 * is available (or meaningful) here, so skip the "active session"
	 * gating entirely and just activate immediately. */
	return init_cb(TRUE);

	if (!monitoring_enabled)
		return init_cb(TRUE);
	...
```

This makes `bluetooth_init_cb()` run synchronously and immediately at plugin
init time (same as obexd's own behavior when built *without* `SYSTEMD`
support at all), while leaving everything else — including which D-Bus bus
`obexd`'s own control API uses — completely untouched. `main.c`'s
`--system-bus` flag is never passed, so `org.bluez.obex` still lands on the
session bus exactly where `tetherd` expects it.

`logind.c.patched` in this directory is the full patched file, for reference
and to diff against if bluez updates.

## Rebuild recipe (if the Debian bluez package version changes)

Run these steps inside a scratch/dev instance of the same base image used by
the main `Dockerfile` (`debian:unstable`), or inside the running `g2-tetherd`
container itself:

```sh
# 1. Enable deb-src and fetch the exact source matching the installed binary
cp /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list.d/debian-src.sources
sed -i 's/^Types:.*/Types: deb-src/' /etc/apt/sources.list.d/debian-src.sources
apt-get update
apt-get install -y dpkg-dev
cd /tmp && apt-get source bluez     # note the exact version fetched, e.g. 5.87-2

# 2. Install build-deps and extract
apt-get build-dep -y bluez
dpkg-source --no-check -x bluez_<version>.dsc
cd bluez-<version>

# 3. Apply the same one-function patch to obexd/src/logind.c (see above),
#    or just copy logind.c.patched over it if the surrounding code hasn't
#    changed upstream.

# 4. Configure with the exact flags Debian's own packaging uses
#    (see debian/rules CONFIGURE_FLAGS in the extracted source) and build
#    only the obexd binary:
./configure --with-dbusconfdir=/usr/share --enable-static --enable-tools \
  --enable-cups --enable-mesh --enable-midi --enable-datafiles \
  --enable-threads --enable-backtrace --enable-debug --enable-library \
  --enable-test --enable-nfc --enable-monitor --enable-udev --enable-obex \
  --enable-client --enable-testing --enable-systemd --enable-sixaxis \
  --enable-deprecated --enable-hid2hci --enable-external-ell \
  --enable-experimental --with-phonebook=ebook
make obexd/src/builtin.h obexd/src/obexd -j$(nproc)

# 5. Copy the result out and replace obexd-patch/obexd in this repo
cp obexd/src/obexd /path/to/repo/docker/tetherd/obexd-patch/obexd
```

Then rebuild the `g2-tetherd` image normally (`docker compose build`).

## Verifying it worked

After deploying, `docker exec g2-tetherd ps aux | grep obexd` should show a
single stable PID that doesn't keep changing, and:

```sh
docker exec -e XDG_RUNTIME_DIR=/run/user/0 g2-tetherd tether --bt-connection
```

should report `Messages (MAP): yes` once paired (not `no_daemon` or
endlessly `Timeout was reached`).
