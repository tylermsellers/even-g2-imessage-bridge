// Durable key-value storage for data that must survive the user closing and
// reopening the app (bridge URL/token, STT provider/key, etc).
//
// The Even Hub host runs the app inside a Flutter WebView, where browser
// `localStorage`/IndexedDB do NOT reliably survive app restarts —
// `bridge.setLocalStorage`/`getLocalStorage` (backed by the native companion
// app) is the reliable persistence mechanism there. We still mirror to
// `localStorage` as a synchronous fallback so the app keeps working in a
// plain browser tab (e.g. `npm run dev` without the simulator/host), where
// `waitForEvenAppBridge()` never resolves, and so simulator testing survives
// a full simulator process restart (the simulator's bridge storage is
// in-memory per-process and is wiped on relaunch, unlike real hardware).
// Exact pattern proven in oura-glance-g2's src/lib/persistentStorage.ts.
import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'

const BRIDGE_TIMEOUT_MS = 2000
// Per-call timeout for the actual getLocalStorage/setLocalStorage RPC
// itself (distinct from BRIDGE_TIMEOUT_MS above, which only bounds
// acquiring the bridge instance). A single native RPC call can hang
// indefinitely on real hardware with no error of its own — see main.ts's
// comments on the concurrent-RPC hang this app hit on real hardware.
const RPC_TIMEOUT_MS = 4000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])
}

let bridgePromise: Promise<EvenAppBridge | null> | null = null

function getBridge(): Promise<EvenAppBridge | null> {
  if (!bridgePromise) {
    bridgePromise = Promise.race([
      waitForEvenAppBridge(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), BRIDGE_TIMEOUT_MS)),
    ]).catch(() => null)
  }
  return bridgePromise
}

export async function getPersistent(key: string): Promise<string | null> {
  const bridge = await getBridge()
  if (bridge) {
    try {
      const value = await withTimeout(bridge.getLocalStorage(key), RPC_TIMEOUT_MS)
      if (value) return value
    } catch {
      // Fall through to the localStorage mirror.
    }
  }
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export async function setPersistent(key: string, value: string): Promise<void> {
  const bridge = await getBridge()
  if (bridge) {
    try {
      await withTimeout(bridge.setLocalStorage(key, value), RPC_TIMEOUT_MS)
    } catch {
      // Ignore — still write the localStorage mirror below.
    }
  }
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Ignore — e.g. storage disabled/full.
  }
}
