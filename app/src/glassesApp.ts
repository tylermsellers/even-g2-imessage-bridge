// Glasses-side list/reader/record/confirm/sent state machine. Ported from
// the earlier g2-imessage attempt's app/src/main.ts (list->record->
// transcribing->confirm->sent), adapted for:
//   - a thread list (tetherd organizes messages by conversation) with a new
//     reader step in between list-select and record, instead of the old
//     flat message feed;
//   - the new bridgeClient (real tetherd-backed reads/sends over our
//     Tailscale-secured bridge) instead of the old Shortcuts+Cloudflare
//     Worker relay;
//   - the new multi-provider BYOK stt/index.ts dispatcher instead of a
//     single hardcoded Whisper call.

import {
  EvenAppBridge,
  AudioInputSource,
  OsEventTypeList,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
} from '@evenrealities/even_hub_sdk'
import { listThreads, listMessages, sendMessage, type Thread, type Message } from './bridgeClient'
import { transcribe } from './stt'
import { isBridgeConfigured } from './config'
import { getTextWidth } from '@evenrealities/pretext'
import { initEvenNotifications, evenNotification } from 'even-notifications'

const CONTAINER_ID = 1
const CONTAINER_NAME = 'main'
const POLL_INTERVAL_MS = 8000
const AUDIO_SAMPLE_RATE = 16000 // matches AudioEventPayload PCM format (16kHz mono s16le)

// ── Voice activity detection (VAD) auto-stop ──────────────────────────────
// Same approach as copilot-glasses-link's main.ts: rather than requiring a
// second manual tap to stop recording, watch the PCM stream itself and
// auto-stop once the user has spoken and then gone quiet for a bit. A
// manual tap still works as a fallback/override at any time (see onSysEvent).
const VAD_RMS_THRESHOLD = 500 // int16 RMS above this counts as "speech" (empirically quiet room vs. speech)
const VAD_SILENCE_MS = 1200 // stop this long after the last detected speech
const VAD_CHECK_INTERVAL_MS = 200
const VAD_MAX_RECORDING_MS = 30_000 // hard safety cap regardless of VAD (e.g. noisy environment)
// Touch hardware can report a single physical tap as two raw events in quick
// succession (press + release). Since a tap on this same full-screen
// container both starts AND stops recording, a spurious second event
// arriving within a moment of starting would immediately stop recording
// again before any audio has streamed. Ignore a manual "stop" tap this soon
// after "start" — real usage always takes at least this long to speak.
const MIN_RECORDING_MS = 600

type Mode = 'threads' | 'reader' | 'record' | 'transcribing' | 'confirm' | 'sent'

let bridge: EvenAppBridge
let mode: Mode = 'threads'
let threads: Thread[] = []
let readerMessages: Message[] = []
let selectedThread: Thread | undefined
// Number of newest messages hidden below the current reader view when the
// user has scrolled back to read older history — 0 = pinned to the latest
// message, matching how the thread list itself always shows current state.
let readerScrollOffset = 0
const READER_PAGE_SIZE = 6
const READER_SCROLL_STEP = 3
// Cap how much history the glasses reader keeps per thread. There's little
// reason to scroll back further than this on a glasses display — the phone
// already has the full conversation — so trimming to the newest N messages
// keeps the reader's scroll depth (and its per-render work) small and
// predictable regardless of how much history tetherd/MAP returns upstream.
const READER_HISTORY_LIMIT = 10
let recording = false
let audioChunks: Uint8Array[] = []
let transcript = ''
let pollTimer: ReturnType<typeof setInterval> | undefined
let audioUnsubscribe: (() => void) | undefined
// VAD auto-stop bookkeeping — see beginRecording/startVadWatch below.
let recordingStartedAt = 0
let vadTimer: ReturnType<typeof setInterval> | undefined
let vadLastVoiceAt = 0
let vadSpeechDetected = false

// Truncates by UTF-8 byte length, not character count — LVGL list-item text
// on the glasses enforces a hard byte limit (63 bytes) at the native layer,
// and rejects the whole rebuildPageContainer call silently (no JS
// exception, no visible error — just a native-side log line) if any item
// exceeds it. A naive character-count truncate let a 64-char string with
// multi-byte UTF-8 content (e.g. the "●" unread bullet or "…" ellipsis, each
// 3 bytes) blow past the byte limit and get dropped, which is what caused
// the glasses screen to hang on "Loading…" forever — confirmed via the
// simulator's own log: "RebuildPageContainer validation failed: list item
// text length 73 exceeds limit of 63 bytes".
function truncate(s: string, maxBytes: number): string {
  const enc = new TextEncoder()
  if (enc.encode(s).length <= maxBytes) return s
  const ellipsis = '…'
  const budget = maxBytes - enc.encode(ellipsis).length
  let result = ''
  let byteCount = 0
  for (const ch of s) {
    const chBytes = enc.encode(ch).length
    if (byteCount + chBytes > budget) break
    result += ch
    byteCount += chBytes
  }
  return result + ellipsis
}

// Absolute clock time for thread-list rows (e.g. "12:04"), replacing the
// old compact relative-age label ("7h") per user feedback — the real
// device-local time is more useful at a glance than an elapsed count, and
// this app's screen has enough width to fit "HH:MM" next to a name.
// Uses the phone/glasses' own local Date object, so it always reflects
// whatever timezone the paired device is actually in.
function formatThreadTime(unixSeconds: number): string {
  if (!unixSeconds) return ''
  const d = new Date(unixSeconds * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let appStarted = false
// Cache of whatever's currently on screen, so a notification popup (see
// even-notifications import) knows what to redraw once it auto-dismisses —
// see initEvenNotifications wiring in startGlassesApp. Populated on every
// rebuild() call, which every page-render in this file goes through instead
// of calling the bridge's container methods directly.
let lastPagePayload: RebuildPageContainer | null = null

// A single native bridge RPC call (createStartUpPageContainer/
// rebuildPageContainer) can hang indefinitely on real hardware with no
// error and no timeout of its own — same class of bug as the concurrent
// bridge.getLocalStorage RPC hang fixed in main.ts (see its comments) and
// persistentStorage.ts's per-call timeout below. Without this, one hung
// rebuild call freezes the glasses screen on whatever was last
// successfully drawn (e.g. the startup "Loading…" placeholder) forever,
// since every render in this file awaits rebuild() directly.
const RPC_TIMEOUT_MS = 6000
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}

async function rebuild(payload: RebuildPageContainer | CreateStartUpPageContainer) {
  lastPagePayload = payload as unknown as RebuildPageContainer
  if (!appStarted) {
    await withTimeout(
      bridge.createStartUpPageContainer(payload as CreateStartUpPageContainer),
      RPC_TIMEOUT_MS,
      'createStartUpPageContainer',
    )
    appStarted = true
    // even-notifications needs the bridge + a way to fetch whatever's
    // currently on screen so it can restore it once a popup dismisses.
    // Registered here (once, after the very first real page exists) rather
    // than at bridge-ready time, since getCurrentPage would have nothing
    // valid to return before that.
    initEvenNotifications(bridge, () => lastPagePayload!)
  } else {
    await withTimeout(bridge.rebuildPageContainer(payload as RebuildPageContainer), RPC_TIMEOUT_MS, 'rebuildPageContainer')
  }
}

function textPage(content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    paddingLength: 8,
    containerID: CONTAINER_ID,
    containerName: CONTAINER_NAME,
    content,
    isEventCapture: 1,
  })
}

function listPage(items: string[]): ListContainerProperty {
  const shown = items.length ? items.slice(0, 20) : ['(none)']
  return new ListContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    paddingLength: 4,
    containerID: CONTAINER_ID,
    containerName: CONTAINER_NAME,
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: shown.length,
      itemWidth: 0,
      isItemSelectBorderEn: 1,
      itemName: shown,
    }),
  })
}

function threadLabel(t: Thread): string {
  // Filled vs. empty circle distinguishes unread (new) from already-read
  // threads — kept per-row too (not just the section header below) so the
  // read state is still visible at a glance within each section.
  const unreadMark = t.unread ? '● ' : '○ '
  const time = formatThreadTime(t.timestamp)
  const suffix = time ? ` (${time})` : ''
  return truncate(`${unreadMark}${t.name}${suffix} - ${t.preview}`, 62)
}

// Section header row — a non-interactive divider line, not a real thread.
// See buildThreadRows: rendered rows and `threads` don't map 1:1 once
// headers are inserted, so onListEvent looks up the tapped row through
// threadRowMap (which has `null` at header positions) rather than indexing
// into `threads` directly.
function sectionHeaderLabel(label: string): string {
  return truncate(`— ${label} —`, 62)
}

// Splits threads into an "Unread" section (newest activity first) and a
// "Read" section, per user feedback — previously all threads were a single
// flat list ordered however tetherd returned them, so an unread message
// could be buried below a long tail of already-read conversations. Each
// group keeps tetherd's original relative order (Array#filter preserves
// it), which is already recency-sorted. Headers are only inserted when
// both sections are non-empty — no point labeling a single section.
function buildThreadRows(all: Thread[]): { items: string[]; map: (Thread | null)[] } {
  const unread = all.filter((t) => t.unread)
  const read = all.filter((t) => !t.unread)
  const items: string[] = []
  const map: (Thread | null)[] = []
  const showHeaders = unread.length > 0 && read.length > 0
  if (showHeaders) {
    items.push(sectionHeaderLabel('Unread'))
    map.push(null)
  }
  for (const t of unread) {
    items.push(threadLabel(t))
    map.push(t)
  }
  if (showHeaders) {
    items.push(sectionHeaderLabel('Read'))
    map.push(null)
  }
  for (const t of read) {
    items.push(threadLabel(t))
    map.push(t)
  }
  return { items, map }
}

// Maps rendered list-row index -> underlying Thread (or null for a section
// header row) — populated by renderThreads, read by onListEvent.
let threadRowMap: (Thread | null)[] = []

async function renderThreads() {
  mode = 'threads'
  const { items, map } = buildThreadRows(threads)
  threadRowMap = map
  await rebuild(
    new RebuildPageContainer({
      containerTotalNum: 1,
      listObject: [listPage(items)],
    }),
  )
}

// Text-only approximation of iMessage's bubble layout (see design-guidelines
// skill: no text alignment/color/background on this display, so "bubbles"
// are simulated via indentation + a directional marker). This is a
// TWO-container layout, not one big scrolling blob:
//   - a small static header container (containerID READER_HEADER_ID,
//     isEventCapture: 0) holding just the contact's name + a divider rule —
//     it never scrolls, since it's a wholly separate native container from
//     the body, not part of the same scrollable text.
//   - a body container (READER_BODY_ID, isEventCapture: 1 — the SDK
//     requires exactly one capture container per page) holding the actual
//     message list.
//
// A full box-drawing border (╭─╮/│ │/╰─╯) per message was tried first, but
// its top/bottom border rows ate roughly half the body container's ~8
// visible lines for one short message — far too costly on a screen this
// small. Replaced per user feedback with compact ">>"/"<<" directional
// markers (received messages get a leading ">> ", sent messages get a
// trailing " <<"), which cost zero extra lines versus the message text
// itself. A blank line is still kept between messages (see
// formatReaderBody's join) so multiple messages remain visually
// delineated without needing a border to do it.
//
// The firmware font is NOT monospaced (see design-guidelines skill), so a
// fixed count of leading space/marker characters lands at a different
// pixel position depending on which characters happen to be nearby — a
// char-count-based "center()"/indent visibly drifted off in testing.
// @evenrealities/pretext's getTextWidth() measures actual glyph widths from
// the same font table LVGL renders with, so every space/marker run below
// is sized from a real measured px budget rather than a guessed char count.
const READER_CONTAINER_WIDTH = 576
const READER_PADDING = 8
const READER_INNER_WIDTH = READER_CONTAINER_WIDTH - 2 * READER_PADDING // 560px
// Header holds a name line + a divider rule (~2 lines); the body gets the
// rest of the 288px screen height.
const READER_HEADER_HEIGHT_PX = 72
const READER_BODY_HEIGHT_PX = 288 - READER_HEADER_HEIGHT_PX
const READER_HEADER_ID = 2
const READER_HEADER_NAME = 'rhdr'
const READER_BODY_ID = 3
const READER_BODY_NAME = 'rbody'
// Average over several spaces for a stable per-space px estimate.
const SPACE_WIDTH_PX = getTextWidth('          ') / 10
const H_RULE_WIDTH_PX = getTextWidth('─')
// Directional markers: received messages are prefixed ">> ", sent messages
// are suffixed " <<". Continuation-wrap lines are indented/padded by the
// same px width so they still visually align under/before the marker.
const INCOMING_MARKER = '>> '
const OUTGOING_MARKER = ' <<'
const INCOMING_MARKER_PX = getTextWidth(INCOMING_MARKER)
const OUTGOING_MARKER_PX = getTextWidth(OUTGOING_MARKER)
// Every message wraps to the same fixed column width, reserving room for
// whichever marker is wider so incoming and outgoing text wrap consistently.
const MESSAGE_TEXT_WIDTH_PX = READER_INNER_WIDTH - Math.max(INCOMING_MARKER_PX, OUTGOING_MARKER_PX)

function spacesForWidth(px: number): string {
  return ' '.repeat(Math.max(0, Math.round(px / SPACE_WIDTH_PX)))
}

function center(text: string, widthPx = READER_INNER_WIDTH): string {
  const w = getTextWidth(text)
  if (w >= widthPx) return text
  return spacesForWidth((widthPx - w) / 2) + text
}

function hRule(widthPx: number): string {
  return '─'.repeat(Math.max(1, Math.round(widthPx / H_RULE_WIDTH_PX)))
}

// One line of a message: prefixed with ">> " (received, left-aligned) on
// its first line and indented to match on continuation lines, or suffixed
// " <<" (sent) with the whole line right-aligned within
// MESSAGE_TEXT_WIDTH_PX + marker width.
function markerLine(text: string, fromMe: boolean, isFirst: boolean): string {
  if (fromMe) {
    const totalPad = Math.max(0, MESSAGE_TEXT_WIDTH_PX - getTextWidth(text))
    const marker = isFirst ? OUTGOING_MARKER : spacesForWidth(OUTGOING_MARKER_PX)
    return `${spacesForWidth(totalPad)}${text}${marker}`
  }
  const marker = isFirst ? INCOMING_MARKER : spacesForWidth(INCOMING_MARKER_PX)
  return `${marker}${text}`
}

// Greedy word-wrap using real glyph widths (getTextWidth), since the
// container's own auto-wrap can't be steered per-line — we need to know
// exactly where each line breaks to draw a matching box around it below.
// Falls back to a char-level split for a single word wider than
// maxWidthPx (e.g. a long URL) so it can never silently overflow.
function wrapText(text: string, maxWidthPx: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (getTextWidth(candidate) <= maxWidthPx) {
      current = candidate
      continue
    }
    if (current) {
      lines.push(current)
      current = ''
    }
    let remaining = word
    while (getTextWidth(remaining) > maxWidthPx && remaining.length > 1) {
      let cut = remaining.length - 1
      while (cut > 1 && getTextWidth(remaining.slice(0, cut)) > maxWidthPx) cut--
      lines.push(remaining.slice(0, cut))
      remaining = remaining.slice(cut)
    }
    current = remaining
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['']
}

// Absolute-time helpers ("Today 9:41 AM"), distinct from the thread list's
// compact relative age ("5h") — the user wants the actual clock time above
// every message once they're reading a conversation.
function formatClockTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const h24 = d.getHours()
  const ampm = h24 >= 12 ? 'PM' : 'AM'
  const h = h24 % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`
}

function formatDateLabel(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// One message = a centered absolute-timestamp line, then its marker-lined
// text (no border rows — see the design note above formatMessageBlock's
// constants for why the box was dropped).
function formatMessageBlock(m: Message): string {
  const timeLabel = center(`${formatDateLabel(m.timestamp)} ${formatClockTime(m.timestamp)}`)
  const wrapped = wrapText(m.body, MESSAGE_TEXT_WIDTH_PX)
  const rows = wrapped.map((line, i) => markerLine(line, !!m.fromMe, i === 0))
  return [timeLabel, ...rows].join('\n')
}

// A blank line between messages is kept here (not part of any per-message
// border) purely so multiple messages stay visually delineated from one
// another once the box border is gone.
function formatReaderBody(msgs: Message[]): string {
  if (msgs.length === 0) return center('(no messages)')
  return msgs.map(formatMessageBlock).join('\n\n')
}

// Static header content: just the contact's name + a divider rule — lives
// in its own never-scrolling container (see READER_HEADER_ID), so it stays
// on screen no matter how far the body container scrolls.
function readerHeaderContent(name: string): string {
  return `${center(name)}\n${hRule(READER_INNER_WIDTH)}`
}

// Native hard limit on a single text container's content, confirmed via
// the simulator's own validation log: "text content length N exceeds limit
// of 999 bytes" (UTF-8 bytes, not JS string length — box-drawing/Unicode
// chars are 3 bytes each, so this fills up far faster than plain ASCII
// text would). Crossing it doesn't just get truncated — it silently
// crashed the simulator process during testing, so this budget must be
// respected before ever calling rebuildPageContainer, not slice()'d after
// the fact. Applies per-container, so splitting header/body into separate
// containers gives the body far more room than the old single-container
// design had.
const READER_CONTENT_BYTE_LIMIT = 999
const utf8 = new TextEncoder()
const byteLength = (s: string) => utf8.encode(s).length
// LVGL text containers do not auto-scroll to their own tail — content is
// simply clipped past the container's pixel height, with no indication
// more exists. So the newest message must actually fit within the body
// container's visible height, not just its 999-byte cap, or opening a
// thread silently shows an older, already-clipped-at-the-bottom messages
// instead of the actual last text. Every line here was already hand
// pre-wrapped to LINE_HEIGHT-appropriate widths (see wrapText/MESSAGE_TEXT
// _WIDTH_PX), so 1 '\n'-delimited line == 1 rendered 27px line, no further
// native wrapping happens.
const LINE_HEIGHT_PX = 27
const READER_BODY_MAX_LINES = Math.floor((READER_BODY_HEIGHT_PX - 2 * READER_PADDING) / LINE_HEIGHT_PX)
const lineCount = (s: string) => s.split('\n').length

// Single-line footer legend using filled-circle glyphs instead of spelled-
// out instructions, separated from the conversation by its own rule —
// saves several lines versus the old two-line "Press to reply./
// Double-press to go back." text while still being unambiguous.
function readerFooter(): string {
  return `\n${hRule(READER_INNER_WIDTH)}\n● reply     ●● back`
}

async function renderReader() {
  mode = 'reader'
  const name = selectedThread?.name ?? ''
  // readerScrollOffset counts how many of the newest messages are hidden
  // below the current page — 0 means pinned to the live tail of the thread.
  // Scroll up/down (see onSysEvent) walks this window back through history,
  // like scrolling up in a real texting thread.
  const maxOffset = Math.max(0, readerMessages.length - READER_PAGE_SIZE)
  readerScrollOffset = Math.min(readerScrollOffset, maxOffset)
  const end = readerMessages.length - readerScrollOffset
  const start = Math.max(0, end - READER_PAGE_SIZE)
  const windowMsgs = readerMessages.slice(start, end)

  const footer = readerFooter()
  const newerHint = readerScrollOffset > 0 ? '\n▼ scroll down for newest' : ''

  // Trim from the oldest end of the current window — same direction
  // "scroll up for older" already implies — until what's left satisfies
  // BOTH constraints: the per-container byte cap (999 bytes, a hard native
  // crash limit) and the body container's actual visible-line budget (so
  // the newest message is never silently clipped off the bottom). The
  // "scroll up for older" hint's own line is folded into the check each
  // iteration, since trimming anything makes that hint true.
  let visible = windowMsgs
  let trimmedFromWindow = false
  const fits = (vis: Message[]) => {
    const hint = start > 0 || trimmedFromWindow ? '▲ scroll up for older\n' : ''
    const candidate = `${hint}${formatReaderBody(vis)}${newerHint}${footer}`
    return byteLength(candidate) <= READER_CONTENT_BYTE_LIMIT && lineCount(candidate) <= READER_BODY_MAX_LINES
  }
  while (visible.length > 1 && !fits(visible)) {
    visible = visible.slice(1)
    trimmedFromWindow = true
  }
  // Extreme edge case: even a single message doesn't fit (e.g. a very long
  // message). Shrink its body text until it does, checking both the byte
  // cap and the visible-line budget.
  if (visible.length === 1 && !fits(visible)) {
    const msg = visible[0]
    let body = msg.body
    while (body.length > 0 && !fits([{ ...msg, body }])) {
      body = body.slice(0, -20)
    }
    visible = [{ ...msg, body: body.length < msg.body.length ? `${body}…` : body }]
  }

  const olderHint = start > 0 || trimmedFromWindow ? '▲ scroll up for older\n' : ''
  const bodyContent = `${olderHint}${formatReaderBody(visible)}${newerHint}${footer}`

  await rebuild(
    new RebuildPageContainer({
      containerTotalNum: 2,
      textObject: [
        new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: READER_CONTAINER_WIDTH,
          height: READER_HEADER_HEIGHT_PX,
          paddingLength: READER_PADDING,
          containerID: READER_HEADER_ID,
          containerName: READER_HEADER_NAME,
          content: readerHeaderContent(name),
          isEventCapture: 0,
        }),
        new TextContainerProperty({
          xPosition: 0,
          yPosition: READER_HEADER_HEIGHT_PX,
          width: READER_CONTAINER_WIDTH,
          height: READER_BODY_HEIGHT_PX,
          paddingLength: READER_PADDING,
          containerID: READER_BODY_ID,
          containerName: READER_BODY_NAME,
          content: bodyContent,
          isEventCapture: 1,
        }),
      ],
    }),
  )
}

// ---------------------------------------------------------------------------
// Data loading + polling (READ path)
// ---------------------------------------------------------------------------

// Snapshot of each thread's read state as of the last poll, so a fresh poll
// can tell "newly unread since last time" apart from "already been unread
// for a while" — used to fire a one-shot popup only on the actual arrival
// of a new message, not on every 8s poll while an old unread lingers.
let threadReadSnapshot = new Map<string, { unread: boolean; timestamp: number }>()
let threadSnapshotSeeded = false

function notifyIfNewMessageArrived(fresh: Thread[]) {
  const prevSnapshot = threadReadSnapshot
  threadReadSnapshot = new Map(fresh.map((t) => [t.id, { unread: !!t.unread, timestamp: t.timestamp }]))
  if (!threadSnapshotSeeded) {
    // First load after boot — every unread thread would look "new" here,
    // so seed the baseline silently instead of firing a popup immediately.
    threadSnapshotSeeded = true
    return
  }
  const arrived = fresh.some((t) => {
    if (!t.unread) return false
    const prev = prevSnapshot.get(t.id)
    return !prev || !prev.unread || t.timestamp > prev.timestamp
  })
  // Only pop up over the home thread-list view — a popup interrupting an
  // in-progress read/record/confirm flow would be more disruptive than
  // useful, and even-notifications restores whatever's on screen anyway.
  if (arrived && mode === 'threads') {
    evenNotification('incoming-email', { durationMs: 4000 })
  }
}

// Threads the user has opened via the glasses app this session — used to
// override tetherd's raw `unread` flag (see below), since it can't be
// trusted to ever clear.
const locallyReadThreadIds = new Set<string>()

// iOS Bluetooth MAP's unread/read-state propagation is a second
// well-documented platform limitation (distinct from, but sibling to, the
// sent-folder wall in bridgeClient.ts): reading a message on the phone
// often never clears its MAP `unread` flag, especially for SMS/non-iMessage
// threads (confirmed 2026-08-31 — user reported threads marked read on
// their phone still showed unread here; corroborated by widely-reported
// iOS MAP read-status-never-syncs reports, e.g. MacRumors forums thread
// "SMS messages don't propagate their read status"). Since the raw flag
// can't be trusted, once the user opens a thread via THIS app we remember
// that locally and force it to read from then on for the rest of the
// session, regardless of what tetherd keeps reporting — this only reflects
// "read via glasses", not "read on phone", but it's the only read signal
// we can actually rely on.
function applyLocalReadOverrides(fresh: Thread[]): Thread[] {
  return fresh.map((t) => (locallyReadThreadIds.has(t.id) ? { ...t, unread: false } : t))
}

async function refreshThreads() {
  try {
    const fresh = applyLocalReadOverrides(await listThreads())
    notifyIfNewMessageArrived(fresh)
    threads = fresh
  } catch (err) {
    console.log('listThreads failed:', err)
  }
  // A failed/timed-out render here must not prevent startPolling() from
  // ever being reached (see startGlassesApp) — otherwise one bad rebuild
  // call permanently stops the poll loop instead of just skipping a frame,
  // and the next tick 8s later never gets a chance to recover.
  if (mode === 'threads') {
    try {
      await renderThreads()
    } catch (err) {
      console.log('renderThreads failed:', err)
    }
  }
}

// Re-fetches the currently-open conversation and re-renders if anything
// changed. Previously, opening a thread only ever loaded messages once
// (see onListEvent) and the 8s poll loop only refreshed the thread LIST —
// so a message arriving while the reader was already open never appeared
// until the user backed out and reopened the thread. This mirrors
// refreshThreads' polling for the reader view specifically.
let readerRefreshInFlight = false
async function refreshReaderMessages() {
  const thread = selectedThread
  if (!thread || readerRefreshInFlight) return
  readerRefreshInFlight = true
  try {
    const fresh = mergeLocalSentEchoes(thread.id, await listMessages(thread.id)).slice(-READER_HISTORY_LIMIT)
    const changed =
      fresh.length !== readerMessages.length ||
      fresh[fresh.length - 1]?.id !== readerMessages[readerMessages.length - 1]?.id
    readerMessages = fresh
    if (changed && mode === 'reader') {
      try {
        await renderReader()
      } catch (err) {
        console.log('renderReader (refresh) failed:', err)
      }
    }
  } catch (err) {
    console.log('refreshReaderMessages failed:', err)
  } finally {
    readerRefreshInFlight = false
  }
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(() => {
    if (mode === 'threads') void refreshThreads()
    else if (mode === 'reader') void refreshReaderMessages()
  }, POLL_INTERVAL_MS)
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = undefined
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

// Local echo of messages sent from THIS app, keyed by thread ID — a partial
// workaround for a hard platform wall (see the NOTE in bridgeClient.ts's
// normalizeMessage): iOS's Bluetooth MAP implementation never exposes the
// sent/outbox folder, so tetherd can never report the user's own replies,
// even ones sent moments ago from this very app. Session-lifetime only
// (not persisted), merged back into whatever tetherd returns every time a
// thread is opened, so at least replies made via the glasses stay visible
// for the rest of this session — replies sent from the phone/iPad directly
// still won't appear; there is no known way to retrieve those over MAP.
const localSentEchoes = new Map<string, Message[]>()

function recordLocalSentEcho(threadId: string, body: string) {
  const echo: Message = {
    id: `local-${Date.now()}`,
    sender: 'me',
    body,
    timestamp: Math.floor(Date.now() / 1000),
    fromMe: true,
  }
  const existing = localSentEchoes.get(threadId) ?? []
  localSentEchoes.set(threadId, [...existing, echo])
}

function mergeLocalSentEchoes(threadId: string, messages: Message[]): Message[] {
  const echoes = localSentEchoes.get(threadId)
  if (!echoes || echoes.length === 0) return messages
  return [...messages, ...echoes].sort((a, b) => a.timestamp - b.timestamp)
}

async function onListEvent(index: number) {
  if (mode !== 'threads') return
  // Row index now maps through threadRowMap (see buildThreadRows) since
  // section header rows are interspersed with real thread rows and aren't
  // 1:1 with `threads` anymore. A tap on a header row (null) is ignored.
  const picked = threadRowMap[index]
  if (!picked) return
  selectedThread = picked
  readerScrollOffset = 0
  locallyReadThreadIds.add(picked.id)
  // Reflect the read override immediately in the in-memory thread list too
  // (not just on the next poll), so going back to the thread list right
  // after reading shows the empty circle without waiting for POLL_INTERVAL_MS.
  const idx = threads.findIndex((t) => t.id === picked.id)
  if (idx !== -1) threads[idx] = { ...threads[idx], unread: false }
  try {
    readerMessages = mergeLocalSentEchoes(picked.id, await listMessages(picked.id)).slice(-READER_HISTORY_LIMIT)
  } catch (err) {
    readerMessages = []
    console.log('listMessages failed:', err)
  }
  await renderReader()
}

async function onSysEvent(sys: { eventType?: number }) {
  const type = sys.eventType ?? 0

  if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    if (mode === 'reader') {
      await returnToThreads()
    } else if (mode === 'record') {
      if (recording) {
        recording = false
        stopVadWatch()
        await bridge.audioControl(false)
      }
      await renderReader()
    } else if (mode === 'confirm') {
      await renderReader()
    } else {
      await bridge.shutDownPageContainer(1)
    }
    return
  }

  if (type === OsEventTypeList.SYSTEM_EXIT_EVENT || type === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    stopPolling()
    stopVadWatch()
    if (recording) await bridge.audioControl(false)
    audioUnsubscribe?.()
    return
  }

  if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    startPolling()
    return
  }

  if (type === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    stopPolling()
    return
  }

  // Scroll gestures page through thread history while reading — up reveals
  // older messages, down walks back toward the live tail.
  if (mode === 'reader' && type === OsEventTypeList.SCROLL_TOP_EVENT) {
    readerScrollOffset += READER_SCROLL_STEP
    await renderReader()
    return
  }
  if (mode === 'reader' && type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    readerScrollOffset = Math.max(0, readerScrollOffset - READER_SCROLL_STEP)
    await renderReader()
    return
  }

  // Single click (0 / undefined) — meaning depends on current mode.
  if (mode === 'reader') {
    await startRecording()
    return
  }

  if (mode === 'record') {
    if (!recording) {
      await startRecording()
    } else {
      // Debounce a spurious immediate second tap — see MIN_RECORDING_MS.
      if (Date.now() - recordingStartedAt < MIN_RECORDING_MS) return
      await stopRecordingAndTranscribe()
    }
    return
  }

  if (mode === 'confirm') {
    await confirmAndSend()
    return
  }
}

// ---------------------------------------------------------------------------
// Voice recording + transcription (feeds the SEND path)
// ---------------------------------------------------------------------------

async function startRecording() {
  audioChunks = []
  recording = true
  mode = 'record'
  recordingStartedAt = Date.now()
  vadLastVoiceAt = recordingStartedAt
  vadSpeechDetected = false
  await rebuild(
    new RebuildPageContainer({
      containerTotalNum: 1,
      textObject: [textPage(`Reply to ${selectedThread?.name ?? ''}\n\n🎙 Recording…\nPress to stop early.`)],
    }),
  )
  const ok = await bridge.audioControl(true, AudioInputSource.Phone)
  if (!ok) {
    // Mic genuinely failed to start (permission not granted, already in
    // use, etc.) — without this check the UI kept showing "Recording…"
    // while capturing zero audio, surfacing later as a confusing empty
    // transcription error instead of a clear failure up front.
    recording = false
    mode = 'reader'
    await rebuild(
      new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: [
          textPage(
            `Reply to ${selectedThread?.name ?? ''}\n\nMic failed to start — check microphone permission for this app on your phone.\n\nPress to try again.`,
          ),
        ],
      }),
    )
    return
  }
  startVadWatch()
}

function stopVadWatch() {
  if (vadTimer) clearInterval(vadTimer)
  vadTimer = undefined
}

// Same RMS-based voice-activity auto-stop used in copilot-glasses-link's
// main.ts: rather than requiring a second manual tap, watch the PCM stream
// and auto-stop once the user has spoken and then gone quiet for a bit. A
// manual tap (see onSysEvent, debounced by MIN_RECORDING_MS) still works as
// a fallback/override at any time.
function startVadWatch() {
  stopVadWatch()
  vadTimer = setInterval(() => {
    if (!recording) {
      stopVadWatch()
      return
    }
    const now = Date.now()
    const heldMs = now - recordingStartedAt
    const silentMs = now - vadLastVoiceAt
    // Only auto-stop on silence once the user has actually said
    // something — otherwise a slow start to speaking would get cut off
    // before it began.
    const pastMinHold = heldMs >= MIN_RECORDING_MS
    if (pastMinHold && ((vadSpeechDetected && silentMs >= VAD_SILENCE_MS) || heldMs >= VAD_MAX_RECORDING_MS)) {
      stopVadWatch()
      void stopRecordingAndTranscribe()
    }
  }, VAD_CHECK_INTERVAL_MS)
}

// Computes RMS (root-mean-square) amplitude of 16-bit signed little-endian
// PCM audio, used to detect speech vs. silence for VAD auto-stop. Reads two
// bytes at a time rather than casting to Int16Array to avoid any assumption
// about the underlying buffer's byte alignment/offset.
function pcmRms(pcm: Uint8Array): number {
  const sampleCount = Math.floor(pcm.length / 2)
  if (sampleCount === 0) return 0
  let sumSquares = 0
  for (let i = 0; i < sampleCount; i++) {
    const lo = pcm[i * 2]
    const hi = pcm[i * 2 + 1]
    let sample = (hi << 8) | lo
    if (sample >= 0x8000) sample -= 0x10000 // sign-extend to int16
    sumSquares += sample * sample
  }
  return Math.sqrt(sumSquares / sampleCount)
}

async function stopRecordingAndTranscribe() {
  recording = false
  stopVadWatch()
  await bridge.audioControl(false)
  mode = 'transcribing'
  await rebuild(
    new RebuildPageContainer({
      containerTotalNum: 1,
      textObject: [textPage(`Reply to ${selectedThread?.name ?? ''}\n\nTranscribing…`)],
    }),
  )

  const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const pcm = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of audioChunks) {
    pcm.set(chunk, offset)
    offset += chunk.length
  }
  audioChunks = []

  if (totalLength === 0) {
    // Fail fast client-side instead of round-tripping an empty body to the
    // STT provider — almost always a mic-permission/start failure, not a
    // network issue. Include the recording duration so a persistent
    // failure here points at an actual streaming problem (e.g. firmware
    // not delivering audioEvent at all) rather than a too-quick stop.
    const heldMs = Date.now() - recordingStartedAt
    mode = 'record'
    await rebuild(
      new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: [
          textPage(
            `Reply to ${selectedThread?.name ?? ''}\n\nNo audio captured (held ${heldMs}ms) — check mic permission.\nPress to try again.\nDouble-press to cancel.`,
          ),
        ],
      }),
    )
    return
  }

  try {
    transcript = await transcribe(pcm, AUDIO_SAMPLE_RATE)
  } catch (err) {
    console.log('transcribe failed:', err)
    transcript = ''
  }

  if (!transcript) {
    mode = 'record'
    await rebuild(
      new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: [
          textPage(`Reply to ${selectedThread?.name ?? ''}\n\nDidn't catch that. Press to try again.\nDouble-press to cancel.`),
        ],
      }),
    )
    return
  }

  mode = 'confirm'
  await rebuild(
    new RebuildPageContainer({
      containerTotalNum: 1,
      textObject: [
        textPage(
          `Reply to ${selectedThread?.name ?? ''}:\n"${transcript}"\n\nPress = Send\nDouble-press = Cancel`,
        ),
      ],
    }),
  )
}

async function confirmAndSend() {
  const thread = selectedThread
  const body = transcript
  mode = 'sent'
  await rebuild(
    new RebuildPageContainer({
      containerTotalNum: 1,
      textObject: [textPage(`Sending to ${thread?.name ?? ''}…`)],
    }),
  )
  try {
    if (thread) {
      await sendMessage(thread.id, body)
      recordLocalSentEcho(thread.id, body)
    }
    await rebuild(
      new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: [textPage(`Sent to ${thread?.name ?? ''}.`)],
      }),
    )
  } catch (err) {
    console.log('sendMessage failed:', err)
    await rebuild(
      new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: [textPage(`Failed to send: ${err instanceof Error ? err.message : String(err)}\n\nPress to go back.`)],
      }),
    )
  }
  setTimeout(() => void returnToThreads(), 2500)
}

async function returnToThreads() {
  mode = 'threads'
  transcript = ''
  selectedThread = undefined
  readerMessages = []
  await renderThreads()
  await refreshThreads()
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function startGlassesApp(evenBridge: EvenAppBridge) {
  bridge = evenBridge

  if (!isBridgeConfigured()) {
    await rebuild(
      new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [
          textPage('Bridge not configured.\nOpen this app from the Even app\nto set the bridge URL, token, and\nyour speech-to-text provider.'),
        ],
      }),
    )
    return
  }

  await rebuild(
    new CreateStartUpPageContainer({
      containerTotalNum: 1,
      listObject: [listPage(['Loading…'])],
    }),
  )

  audioUnsubscribe = bridge.onEvenHubEvent((event) => {
    if (event.listEvent) {
      void onListEvent(event.listEvent.currentSelectItemIndex ?? 0)
      return
    }
    // Text containers (our reader/confirm/record screens) report clicks and
    // scroll gestures via textEvent, not sysEvent — sysEvent only carries
    // app-lifecycle events (foreground/exit) plus click on non-text pages.
    // Both share the same { eventType } shape, so onSysEvent handles either.
    if (event.textEvent) {
      void onSysEvent(event.textEvent)
      return
    }
    if (event.sysEvent) {
      void onSysEvent(event.sysEvent)
      return
    }
    if (event.audioEvent && recording) {
      audioChunks.push(event.audioEvent.audioPcm)
      if (pcmRms(event.audioEvent.audioPcm) >= VAD_RMS_THRESHOLD) {
        vadLastVoiceAt = Date.now()
        vadSpeechDetected = true
      }
    }
  })

  try {
    await refreshThreads()
  } catch (err) {
    console.log('initial refreshThreads failed:', err)
  }
  startPolling()
}
