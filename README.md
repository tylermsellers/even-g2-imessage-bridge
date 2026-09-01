# G2 iMessage Bridge — Working Implementation + Feature Request

**Author:** Tyler Sellers
**Status:** ✅ Working end-to-end (real hardware) — glasses app reads/replies to iMessage/SMS threads via a self-hosted bridge, no jailbreak, no Mac proxy.

This repo has two parts:
1. **A working self-hosted implementation** (`docker/` + `app/`) — a Docker
   stack that pairs a spare Linux box with your iPhone over Bluetooth (ANCS +
   MAP + PBAP), exposes it as an HTTPS API, and an Even Hub G2 glasses app
   that reads/replies to threads through it. This is what you can actually
   run today.
2. **A feature request** (below the architecture section) asking Even
   Realities to build the equivalent natively into the G2 companion app/
   firmware, so no separate Linux box is required.

---

## Architecture

```
 iPhone  <--Bluetooth (ANCS+MAP+PBAP)-->  Linux host (tetherd, BlueZ)
                                                |
                                          UNIX socket (local only)
                                                |
                                          bridge (Node, Express)
                                          binds 127.0.0.1 only
                                                |
                                   Tailscale container (host network)
                                     Funnel: public HTTPS -> 127.0.0.1
                                                |
                                        HTTPS (token-authed)
                                                |
                                  Even Hub G2 glasses app (this repo's app/)
                                  + phone Settings screen (pairing/config)
```

- **`docker/tetherd/`** — runs [zackb/tether](https://github.com/zackb/tether)'s
  daemon (`tetherd`) against a passed-through USB Bluetooth adapter.
  `network_mode: host` + `privileged: true` for raw HCI/D-Bus access.
  Bluetooth bond storage (`/var/lib/bluetooth`) and tetherd's own config are
  both bind-mounted to the host so `docker compose down/up` never wipes a
  hard-won pairing.
- **`docker/bridge/`** — a small Node/Express service that talks to
  `tetherd` over its local-only UNIX socket (never TCP — this is
  intentional in upstream `tether`, since everything on that socket is
  personal message data) and re-exposes it as a token-authed HTTPS JSON
  API (`/api/threads`, `/api/messages/:address`, `/api/send`, `/api/health`).
  Binds to `127.0.0.1` only inside its container — never directly
  LAN-reachable.
- **`docker/tailscale/`** — a Tailscale container (host network) running
  **Funnel**, which exposes the bridge's `127.0.0.1` service at a public
  HTTPS URL (`https://<your-node-name>.<your-tailnet>.ts.net`) with a
  Tailscale-issued cert. This is what actually gets reachability from a
  phone that isn't itself on the tailnet (e.g. over cellular data, or when
  your carrier/VPN policy rules out installing Tailscale on the phone
  itself — this was the case here).
- **`app/`** — the Even Hub G2 app (TypeScript + `@evenrealities/even_hub_sdk`).
  Two surfaces:
  - **Glasses UI**: thread list (unread dot, relative timestamp, `<<`/`>>`
    direction markers) → reader (chat-bubble-style indentation, scrollback
    paging, sender header) → voice reply (VAD auto-stop recording → STT →
    confirm → send via the bridge's `/api/send`).
  - **Phone Settings UI** (intentionally minimal, per design decision):
    bridge URL/token entry (manual or QR-code camera scan), STT
    provider/key, and a connection test — no message content is ever shown
    on the phone, by design; all reading/replying happens on-glasses.

## What worked

- **ANCS + MAP + PBAP over a real Bluetooth Classic+LE dual bond** — full
  thread read, history read, and *send* (not just notification mirroring).
  This is the core finding: MAP gives real reply capability that ANCS alone
  cannot.
- **Tailscale Funnel** for public HTTPS reachability without opening a
  router port or relying on the phone joining the tailnet — necessary here
  since a work VPN policy ruled out installing Tailscale on the iPhone
  itself.
- **QR-code pairing** (camera scan of a `{"u":...,"t":...}` JSON payload)
  to avoid manually typing the bridge URL/token/STT key on a phone
  keyboard.
- **Text-container scroll/click gestures arrive as `event.textEvent`, not
  `event.sysEvent`** — this isn't documented prominently outside the SDK's
  own README appendix and cost real debugging time; worth flagging for
  anyone else building a scrollable-text glasses app.
- **`bridge.shutDownPageContainer(1)`** (confirmation-dialog exit mode) is
  the correct double-tap "exit app" flow; cleanup must happen in the
  `SYSTEM_EXIT_EVENT`/`ABNORMAL_EXIT_EVENT` handlers, not before the exit
  call, or a cancelled exit leaves the app on-screen but deaf to input.

## What didn't work / dead ends

- **No self-pairing on iOS.** A sandboxed app cannot request its own
  device's notifications/messages this way — the whole protocol only works
  because the accessory (in this case, the Linux box, standing in for what
  should eventually be the glasses themselves) is a *separate* physical
  Bluetooth device pairing to the phone. This is why a Linux-box relay (or
  eventually native G2 firmwarwe/companion-app support) is required, not
  optional.
- **No Even Hub SDK path exists today.** `@evenrealities/even_hub_sdk`
  v0.0.14 has no Bluetooth/notification-access API — confirmed by
  inspection, not just docs. This is squarely an Even Realities
  firmware/companion-app gap, not something a third-party app can route
  around.
- **Real-hardware-only concurrency bug**: rendering the phone Settings UI
  unconditionally at startup (a workaround for the simulator's separate
  preview window never firing `onLaunchSource`) caused two concurrent
  `bridge.getLocalStorage` RPC calls on real hardware (glasses boot path +
  phone boot path), which the native bridge doesn't handle the way the
  simulator's in-memory stub does — manifesting as a blank phone screen and
  a glasses UI stuck on "Loading…". Fixed by gating phone-UI rendering
  strictly behind a confirmed `onLaunchSource === 'appMenu'` event (never
  unconditional), plus adding timeouts to all storage/page-container RPCs
  as defense-in-depth.
- **Notification mirroring (ANCS) does not work on iOS 18 and earlier** —
  per BlueFerry's own findings, needs iOS 19+. Not something this project
  can fix; noted here since it affects the phased-scope feature request
  below.

## Repo layout

```
docker/            Bridge stack: tetherd (Bluetooth), bridge (HTTPS API), tailscale (Funnel)
app/                Even Hub G2 glasses app (TypeScript, this project's actual deliverable)
server/             Early Node proof-of-concept client (tetherClient.js) — superseded by docker/bridge
GITHUB-COMMENT-issue-24.md   Draft comment for Even Realities' own SDK issue tracker (redacted, no bridge URL/tokens)
```

---

## Feature Request: Native iMessage/SMS + Notification Integration for G2

**Audience:** Even Realities firmware/companion-app engineering
**Where to file:** [github.com/even-realities/everything-evenhub/issues](https://github.com/even-realities/everything-evenhub/issues)
(the SDK's own issue tracker — search first for existing BLE/notification-access requests to avoid a duplicate)

## The ask, in one sentence

Let the G2's own iOS companion app pair with the iPhone as a real Bluetooth
accessory (like a car head unit or Apple Watch does today) so it can read
*and reply to* iMessage/SMS and mirror live notifications — natively, with
no phone-side relay box, jailbreak, or Mac proxy required — and expose the
result to third-party Even Hub apps through a small, permissioned SDK API.

## Why a third-party developer can't build this today

I tried to build exactly this as an Even Hub app. Dead end, for reasons that
are Apple-platform-level, not just SDK gaps:

1. **The Even Hub SDK sandbox has no Bluetooth/pairing access at all.**
   Confirmed against `@evenrealities/even_hub_sdk` v0.0.14 — no notification
   API, no raw BT, nothing to intercept Messages. Today's on-glasses
   notification reading is a built-in feature of Even's own app, not
   something exposed to third-party glasses apps.
2. **Even if it were exposed, iOS won't let a sandboxed app do this to
   itself.** The protocols that make this possible (below) work by having
   the iPhone treat a *separate physical device* as a paired Bluetooth
   accessory. There is no supported (or unsupported-but-possible) way for
   an app running on the same iPhone to request its own notifications or
   messages this way — self-pairing isn't a thing. So even a fully native,
   Apple-approved companion app hits a wall unless the *glasses themselves*
   are the Bluetooth accessory that pairs to the phone — which they already
   are, physically. The gap is firmware/companion-app capability, not
   sandboxing of a third-party app.
3. **This has to live in Even's own native companion app + glasses
   firmware**, with real Bluetooth Classic (BR/EDR) + BLE dual-bearer
   pairing control — not reachable from a WebView/Even Hub JS app, and not
   something a third-party developer can add themselves.

So this is squarely a request for Even's own engineering team.

## What actually makes this possible (no jailbreak, no private APIs)

I found a working, MIT-licensed reference implementation:
**[zackb/tether](https://github.com/zackb/tether)** (a Linux/Wayland
"Continuity" clone), which itself builds on protocol research from
**[ancs4linux](https://github.com/pzmarzly/ancs4linux)** and
**[erikwb/blueferry](https://github.com/erikwb/blueferry)** (see its
[`PROTOCOL.md`](https://github.com/erikwb/blueferry/blob/main/PROTOCOL.md)
for the empirical pairing/behavior notes). None of this relies on anything
Apple considers private:

- **ANCS** (Apple Notification Center Service) — a public BLE GATT service
  iOS exposes to paired accessories (this is how Pebble/Garmin/Apple Watch
  show notifications). Gives live notification title/message/app + basic
  positive/negative actions.
- **MAP** (Message Access Profile) — a standard Bluetooth Classic profile,
  the same one car head units use to read *and send* SMS/iMessage text.
  This is the piece that gives real reply capability without Shortcuts
  hacks or a Mac/BlueBubbles proxy.
- **PBAP** (Phone Book Access Profile) — standard contact sync, same
  car-kit mechanism.

### Pairing shape (from BlueFerry's documented findings)

- The accessory presents Class of Device = **A/V Hands-Free** (major 4,
  minor 8) during pairing — same class a car kit uses.
- No LE advertisement is active during Classic pairing; a bonded ANCS
  solicitation advert only shows up after the Classic bond exists.
- The accessory should **not** initiate `Pair()` directly — instead call
  `Connect()` on the unpaired device and let iOS initiate authentication as
  central; this is what produces a single dual Classic+LE bond instead of
  two separate device records.
- After pairing, the iPhone's Bluetooth settings for that accessory show
  **"Show Message Notifications"** and **"Sync Contacts"** toggles — both
  must be enabled by the user, once.
- Notification mirroring does not work on iOS 18 and earlier (needs 19+).

### The resulting wire protocol (for scoping engineering effort)

Tether's daemon exposes exactly the primitives G2 would need, over a simple
line-delimited JSON socket:

| Command | Purpose |
|---|---|
| `bt_threads` | List message conversations (name, timestamp, preview, unread count) |
| `bt_list_messages` | Full message history for one conversation |
| `bt_send_message` | Send a reply — real MAP push, not a workaround |
| `bt_notifications` | Live mirrored notifications from any phone app |
| `bt_status` / `bt_devices` / `bt_connection` | Pairing/connection health |

I've attached `server/src/tetherClient.js` in this repo as a minimal Node
proof-of-concept client for that protocol (talking to a real `tetherd` over
TCP) — useful as a concrete reference for the shape of the data, not as
something Even needs to reuse verbatim (their implementation would live in
Swift/native BT code, not Node).

## What I'd want exposed to Even Hub apps once this exists

A small, permissioned SDK surface so third-party apps (not just Even's own
built-in notification view) can build on it, e.g.:

- `bridge.onMessageReceived(callback)` — live incoming SMS/iMessage + sender/thread
- `bridge.getMessageThreads()` / `bridge.getThreadMessages(threadId)`
- `bridge.sendMessage(threadId, body)`
- `bridge.onNotification(callback)` with app name, title, body, positive/negative actions
- A new `permissions` entry in `app.json` (e.g. `"messages"` /
  `"notifications"`) so users explicitly consent per-app, same pattern as
  `g2-microphone` today.

## Suggested phased scope (smallest useful slice first)

1. **Read-only notifications via ANCS** — lowest engineering lift, closest
   to what the built-in app already does; exposing it via SDK is the main
   delta.
2. **Read messages via MAP** — full thread/history read.
3. **Send via MAP** — the actual "reply from the glasses" capability.
4. **Contacts via PBAP** — nice-to-have, resolves thread IDs to names.

## Why this is worth it

This turns "glasses that show a notification preview" into "glasses you can
actually have a text conversation through" — genuinely portable, no
companion box, no jailbreak, using the same standard car-kit Bluetooth
profiles Apple already ships support for. Happy to share more detail,
the proof-of-concept client, or test an early build.
