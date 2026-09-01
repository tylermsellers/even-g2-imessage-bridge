import type { LaunchSource } from '@evenrealities/even_hub_sdk'
import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { renderPhoneApp } from './phoneApp'
import { startGlassesApp } from './glassesApp'
import { loadConfig } from './config'

document.body.innerHTML = '<div style="font-family:sans-serif;padding:20px;color:#666">Loading iMessage…</div>'

function showFatalError(err: unknown) {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  document.body.innerHTML = `<pre style="font-family:monospace;padding:20px;color:#b3261e;white-space:pre-wrap;">iMessage app failed to start:\n\n${message}</pre>`
}
window.addEventListener('error', (e) => showFatalError(e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => showFatalError(e.reason))

// Same proven pattern as copilot-glasses-link's main.ts — waitForEvenAppBridge()
// resolves fine in every context (glasses display, simulator, and real
// hardware). This bridge instance drives onLaunchSource + the glasses UI
// below; config persistence (loadConfig/saveConfig) uses its own
// independent bridge resolution with a localStorage mirror — see
// persistentStorage.ts.
let bridge: EvenAppBridge
try {
  bridge = await waitForEvenAppBridge()
} catch (err) {
  showFatalError(err)
  throw err
}

// Register onLaunchSource immediately — it fires exactly once, so this must
// happen before anything else can race it.
//
// Gate phone-UI rendering strictly behind a confirmed 'appMenu' source,
// matching copilot-glasses-link's proven, real-hardware-tested pattern.
// An earlier version of this file rendered the phone UI unconditionally
// (immediately, regardless of source) to work around the simulator's
// separate "Browser" preview window never firing onLaunchSource — but that
// meant renderPhoneApp()'s own loadConfig() call ran concurrently with the
// glasses-side loadConfig()/startGlassesApp() in bootFromSource whenever
// launched to the glasses, both issuing overlapping bridge.getLocalStorage
// RPCs at once. On real hardware this produced a blank phone screen and a
// glasses UI stuck forever on the startup "Loading…" placeholder (the
// native bridge channel doesn't handle concurrent overlapping RPCs the way
// the simulator's in-memory stub does). Reverted to the gated pattern.
let bootedAs: LaunchSource | null = null
let glassesStarted = false
async function bootFromSource(source: LaunchSource) {
  if (bootedAs === source) return
  bootedAs = source
  if (source === 'appMenu') {
    void renderPhoneApp(bridge)
    return
  }
  if (glassesStarted) return
  glassesStarted = true
  await loadConfig()
  await startGlassesApp(bridge)
}

let sourceHandled = false
bridge.onLaunchSource((source) => {
  sourceHandled = true
  void bootFromSource(source)
})
setTimeout(() => {
  if (!sourceHandled) void bootFromSource('glassesMenu')
}, 1500)

