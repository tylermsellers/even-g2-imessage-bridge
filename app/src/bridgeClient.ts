// Thin client for our own docker/bridge service (see
// docker/bridge/src/index.js) — the only thing ever exposed via Tailscale
// Funnel. Every request carries the shared BRIDGE_TOKEN as the
// `x-bridge-token` header, matching the bridge's auth middleware.

import { getConfig } from './config'

export interface Thread {
  id: string
  name: string
  preview: string
  timestamp: number
  unread?: boolean
}

export interface Message {
  id: string
  sender: string
  body: string
  timestamp: number
  fromMe: boolean
}

// tetherd's real bt_threads/bt_list_messages shapes (confirmed against a
// live bridge response on docker-host, 2026-08-31):
//   thread:  { thread, name, address, preview, timestamp, unread, count, group, repliable }
//   message: { thread, name, address, body, timestamp, outgoing, read, handle, folder }
// The bridge passes tetherd's JSON straight through unmodified, so we
// normalize into our own stable shape here.
function normalizeThread(raw: Record<string, any>): Thread {
  return {
    id: String(raw.thread ?? raw.id ?? ''),
    name: String(raw.name ?? raw.address ?? 'Unknown'),
    preview: String(raw.preview ?? ''),
    timestamp: Number(raw.timestamp ?? 0),
    unread: Boolean(raw.unread),
  }
}

// NOTE on `outgoing`/fromMe (confirmed via live debug logging against the
// real bridge, 2026-08-31): every message tetherd returns for a thread has
// `outgoing: false` and `folder: "/telecom/msg/inbox"`, even for threads
// the user has definitely replied to from their phone/iPad. This is NOT a
// parsing bug here — it's a hard platform limitation of iOS's Bluetooth
// MAP (Message Access Profile) implementation: Apple's MAP server only
// exposes the inbox folder over Bluetooth; queries against the sent/outbox
// folder are documented to always return zero messages on iOS, regardless
// of client (this affects car head units the same way). tetherd has no way
// around this since it talks to the same MAP interface. `fromMe` is kept
// here for forward-compatibility (in case a future tetherd/tether version
// adds a workaround, e.g. merging in messages sent via this app itself),
// but do not expect it to ever be true from `bt_list_messages` today.
function normalizeMessage(raw: Record<string, any>): Message {
  return {
    id: String(raw.handle ?? raw.id ?? `${raw.timestamp ?? ''}`),
    sender: String(raw.name ?? raw.address ?? ''),
    body: String(raw.body ?? ''),
    timestamp: Number(raw.timestamp ?? 0),
    fromMe: Boolean(raw.outgoing),
  }
}

// A single BLE/relay hop can hang indefinitely otherwise — hard timeout
// keeps the glasses UI from ever getting stuck on a spinner forever.
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function req<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
  const { bridgeUrl, bridgeToken } = getConfig()
  if (!bridgeUrl) throw new Error('Bridge not configured')
  const res = await fetchWithTimeout(
    `${bridgeUrl}${path}`,
    {
      ...init,
      headers: {
        ...(init.headers || {}),
        'x-bridge-token': bridgeToken,
      },
    },
    timeoutMs,
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Bridge request failed: ${res.status}`)
  }
  return res.json()
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await req<{ ok: boolean }>('/api/health')
    return !!res.ok
  } catch {
    return false
  }
}

export async function listThreads(): Promise<Thread[]> {
  const res = await req<{ threads: Record<string, any>[] }>('/api/threads')
  return (res.threads || []).map(normalizeThread)
}

export async function listMessages(threadId: string): Promise<Message[]> {
  const res = await req<{ messages: Record<string, any>[] }>(`/api/messages/${encodeURIComponent(threadId)}`)
  return (res.messages || []).map(normalizeMessage)
}

export async function sendMessage(threadId: string, body: string): Promise<void> {
  await req<{ ok: boolean }>(
    '/api/send',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread: threadId, body }),
    },
    15000, // bt_send_message is async on tetherd's side; give it real time
  )
}
