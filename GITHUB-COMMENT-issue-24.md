This is exactly the gap I hit trying to build a "reply to iMessage from the
glasses" app — wanted to add some findings that extend this request beyond
read-only notifications, since the same Bluetooth pairing that unlocks ANCS
also unlocks **real reply capability**, not just a mirror.

## The missing piece: MAP, not just ANCS

ANCS (as filed here) gets you notification previews, but iOS has no
supported way to *send* a reply through it. There's a second, equally
public/standard Bluetooth Classic profile that solves that:

- **MAP** (Message Access Profile) — the same profile car head units use to
  read *and send* SMS/iMessage text. No jailbreak, no private API, no
  Mac/BlueBubbles proxy.
- **PBAP** (Phone Book Access Profile) — standard contact sync, resolves
  thread IDs to names.

I found a working, MIT-licensed reference implementation that combines all
three (ANCS + MAP + PBAP) for exactly this purpose:
[zackb/tether](https://github.com/zackb/tether) (a Linux "Continuity"
clone), building on protocol research from
[ancs4linux](https://github.com/pzmarzly/ancs4linux) and
[erikwb/blueferry](https://github.com/erikwb/blueferry) — see the latter's
[`PROTOCOL.md`](https://github.com/erikwb/blueferry/blob/main/PROTOCOL.md)
for the documented pairing/behavior details (Class of Device spoofed as A/V
Hands-Free, Connect-first authentication so iOS drives a single dual
Classic+LE bond, then user enables "Show Message Notifications"/"Sync
Contacts" once in iPhone Bluetooth settings).

## Suggested expanded API surface

Building on the `onNotification` shape already proposed here:

```ts
onNotification((n) => {
  // n.appId, n.title, n.body, n.timestamp, n.category  — ANCS, as filed
})

onMessageReceived((m) => {
  // m.threadId, m.body, m.timestamp — MAP
})

getMessageThreads(): Thread[]          // MAP
getThreadMessages(threadId): Message[] // MAP
sendMessage(threadId, body): Promise<void> // MAP — actual reply, not a workaround
```

Would probably want its own permission (e.g. `"messages"`) separate from
generic `"notifications"`, since it's a materially bigger ask (send
capability, not just read).

## Suggested phased scope

1. Read-only notifications via ANCS (this issue, as filed) — smallest lift.
2. Read message threads/history via MAP.
3. Send via MAP — the actual "reply from the glasses" capability.
4. Contacts via PBAP (nice-to-have, resolves names).

Happy to share a small Node proof-of-concept client I wrote against
`tetherd`'s wire protocol if useful as a reference for the data shapes
involved — it's obviously not something Even would reuse directly (this
needs to live in the native companion app/firmware's own BT stack, not a
third-party relay), but it's a concrete existence proof this is
implementable without anything Apple would consider private API abuse.
