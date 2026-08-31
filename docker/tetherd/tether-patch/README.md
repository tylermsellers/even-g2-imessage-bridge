# 30-day MAP message history filter

By default, `tetherd` backfills and polls up to 200 messages per folder
(inbox + sent) with no date limit — see upstream
`src/core/src/bluetooth/connection.cpp`'s `sync_messages()` and
`MESSAGE_LIST_MAX`. On a mailbox with a long history, that can pull messages
that are months or years old into `tetherd`'s local plaintext journal
(`~/.local/share/tether/messages.ndjson` inside the container).

These patches add a 30-day cutoff (`MESSAGE_HISTORY_DAYS` in
`connection.cpp`), enforced via BlueZ's MAP `PeriodBegin` filter key (see
`org.bluez.obex.MessageAccess(5)`). This filtering happens **on the phone**,
not in `tetherd` — older messages are never transferred over Bluetooth in the
first place, so they never reach the container's journal at all.

## Files

- `0001-map-session-hpp.patch` — adds an optional `period_begin` parameter to
  `MapSession::list_messages()`.
- `0002-map-session-cpp.patch` — has `list_messages()` add a `PeriodBegin` key
  to the OBEX `ListMessages` filter dict when `period_begin` is non-empty.
- `0003-connection-cpp.patch` — adds the `MESSAGE_HISTORY_DAYS = 30` constant
  and a helper that formats "N days ago" in BlueZ's `YYYYMMDDTHHMMSS` filter
  format, then passes it into all three `list_messages()` call sites in
  `sync_messages()` (initial folder listing, inbox fallback, sent folder).
- `apply.sh` — applies all three patches in order via `patch -p1`, called
  from the Dockerfile right after `git clone` and before the `cmake`
  configure/build steps.

## Changing the window

`MESSAGE_HISTORY_DAYS` is a compile-time constant in `connection.cpp` (patch
`0003`). To change it, edit the patch file's `+constexpr int
MESSAGE_HISTORY_DAYS = 30;` line and rebuild the `tetherd` image
(`docker compose build tetherd && docker compose up -d tetherd`). It is not
currently exposed as a runtime environment variable.

## If upstream changes and a patch stops applying

`apply.sh` uses `patch -p1 --forward` under `set -e`, so the Docker build
will fail loudly (rather than silently skip the patch) if upstream's
`tether` source has drifted enough that a hunk's context no longer matches.
If that happens, re-fetch the current upstream file, regenerate the affected
patch's context lines and line numbers, and re-verify the diff applies
cleanly with `patch --dry-run -p1`.
