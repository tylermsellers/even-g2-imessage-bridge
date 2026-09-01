// Phone companion UI: configure the bridge connection (Tailscale Funnel URL
// + shared BRIDGE_TOKEN) and the user's own speech-to-text provider/API key
// (bring-your-own-key: Azure, OpenAI, Deepgram, or Soniox). Config is shared
// with the glasses app via bridge.getLocalStorage/setLocalStorage — see
// config.ts. Styling follows g2-protonmail's phoneApp.ts, matched against
// the current Even Hub design tokens (app-guidelines.md).

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import jsQR from 'jsqr'
import { checkHealth } from './bridgeClient'
import { loadConfig, saveConfig, type SttProvider } from './config'

function app(): HTMLElement {
  return document.getElementById('app')!
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

// Decodes a QR code from a captured phone-camera photo. Loads the base64
// image into an <img>, draws it to an offscreen canvas, then runs jsQR
// against the raw pixel data. Returns the decoded text, or null if no QR
// code was found in the frame.
async function decodeQrFromImage(base64: string, mimeType: string): Promise<string | null> {
  const img = new Image()
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Could not load captured image.'))
  })
  img.src = `data:${mimeType};base64,${base64}`
  await loaded

  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const code = jsQR(imageData.data, imageData.width, imageData.height)
  return code?.data ?? null
}

const STYLE = `
  :root {
    --bg: #EEEEEE;
    --bg-elevated: #FFFFFF;
    --label: #232323;
    --label-secondary: #7B7B7B;
    --separator: #E4E4E4;
    --green: #4BB956;
    --red: #FF453A;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--label); font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif; }
  #app { padding: 20px 12px; max-width: 480px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; font-weight: 600; margin: 24px 0 12px; color: var(--label-secondary); text-transform: uppercase; letter-spacing: 0.02em; }
  p.sub { font-size: 13px; color: var(--label-secondary); margin: 0 0 16px; }
  .field { margin-bottom: 16px; }
  .field label { display: block; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.02em; color: var(--label-secondary); margin-bottom: 6px; }
  .field input, .field select { width: 100%; padding: 12px 14px; border-radius: 6px; border: 1px solid var(--separator); background: var(--bg-elevated); color: var(--label); font-size: 16px; font-family: inherit; }
  .btn { width: 100%; padding: 13px 16px; border-radius: 6px; border: none; font-size: 16px; font-weight: 600; font-family: inherit; cursor: pointer; background: #232323; color: #fff; margin-top: 4px; }
  .btn:disabled { opacity: 0.5; }
  .status { margin-top: 16px; padding: 12px 14px; border-radius: 6px; background: var(--bg-elevated); border: 1px solid var(--separator); font-size: 14px; }
  .status.ok { color: var(--green); }
  .status.error { color: var(--red); }
  .hint { font-size: 12px; color: var(--label-secondary); margin-top: 8px; line-height: 1.5; }
  .provider-fields { display: none; }
  .provider-fields.active { display: block; }
  .btn-secondary { background: var(--bg-elevated); color: var(--label); border: 1px solid var(--separator); }
`

const PROVIDER_LABELS: Record<SttProvider, string> = {
  azure: 'Azure Speech',
  openai: 'OpenAI (Whisper / gpt-4o-transcribe)',
  deepgram: 'Deepgram',
  soniox: 'Soniox',
}

export async function renderPhoneApp(bridge?: EvenAppBridge) {
  // Recreate #app fresh — main.ts's initial "Loading…" placeholder replaces
  // document.body.innerHTML wholesale (see copilot-glasses-link's
  // renderPhoneApp for the same pattern), which destroys the original
  // <div id="app"> from index.html. Without this, app() below would return
  // null and every render call would throw.
  document.body.innerHTML = '<div id="app"></div>'
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.appendChild(style)

  const cfg = await loadConfig()
  const provider: SttProvider = (cfg.sttProvider || 'deepgram') as SttProvider

  app().innerHTML = `
    <h1>iMessage — Settings</h1>
    <p class="sub">Connects to your own bridge (Tailscale-secured) and your chosen speech-to-text provider for voice replies.</p>

    <h2>Bridge</h2>
    <div class="field">
      <label>Bridge URL</label>
      <input id="bridgeUrl" type="text" placeholder="https://your-node.your-tailnet.ts.net" value="${escapeHtml(cfg.bridgeUrl)}" />
    </div>
    <div class="field">
      <label>Bridge Token</label>
      <input id="bridgeToken" type="text" placeholder="shared secret from docker/bridge/.env" value="${escapeHtml(cfg.bridgeToken)}" />
    </div>
    <button class="btn btn-secondary" id="scanQrBtn" ${bridge ? '' : 'disabled'}>Scan Setup QR Code</button>
    <div id="qrStatusBox"></div>
    <p class="hint">
      Generate the QR code once with <code>node scripts/gen-pair-qr.mjs</code>
      on your docker host (see docker/tailscale/README.md) — it encodes your
      bridge URL + token so you don't have to type the long token by hand.
    </p>

    <h2>Speech-to-Text</h2>
    <div class="field">
      <label>Provider</label>
      <select id="sttProvider">
        ${(Object.keys(PROVIDER_LABELS) as SttProvider[])
          .map((p) => `<option value="${p}" ${p === provider ? 'selected' : ''}>${PROVIDER_LABELS[p]}</option>`)
          .join('')}
      </select>
    </div>
    <div class="field">
      <label>API Key</label>
      <input id="sttKey" type="text" placeholder="your own provider API key" value="${escapeHtml(cfg.sttKey)}" />
    </div>
    <div class="field provider-fields" id="azureRegionField">
      <label>Azure Region</label>
      <input id="sttRegion" type="text" placeholder="e.g. eastus" value="${escapeHtml(cfg.sttRegion)}" />
    </div>

    <button class="btn" id="saveBtn">Save & Test Connection</button>
    <div id="statusBox"></div>
    <p class="hint">
      Your speech-to-text API key is sent directly from your phone to that
      provider's own API — it never passes through our bridge or tetherd.
      Keep the bridge token private; it grants read/reply access to your
      iMessages/SMS.
    </p>
  `

  const urlInput = document.getElementById('bridgeUrl') as HTMLInputElement
  const tokenInput = document.getElementById('bridgeToken') as HTMLInputElement
  const providerSelect = document.getElementById('sttProvider') as HTMLSelectElement
  const keyInput = document.getElementById('sttKey') as HTMLInputElement
  const regionField = document.getElementById('azureRegionField')!
  const regionInput = document.getElementById('sttRegion') as HTMLInputElement
  const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement
  const statusBox = document.getElementById('statusBox')!

  function updateProviderFields() {
    regionField.classList.toggle('active', providerSelect.value === 'azure')
  }
  providerSelect.addEventListener('change', updateProviderFields)
  updateProviderFields()

  const scanQrBtn = document.getElementById('scanQrBtn') as HTMLButtonElement
  const qrStatusBox = document.getElementById('qrStatusBox')!

  scanQrBtn.addEventListener('click', async () => {
    if (!bridge) return
    scanQrBtn.disabled = true
    qrStatusBox.innerHTML = `<div class="status">Opening camera…</div>`
    try {
      const asset = await bridge.captureImageFromCamera()
      if (!asset || !asset.base64) {
        qrStatusBox.innerHTML = `<div class="status error">Camera cancelled or returned no image.</div>`
        return
      }
      qrStatusBox.innerHTML = `<div class="status">Decoding…</div>`
      const data = await decodeQrFromImage(asset.base64, asset.mimeType || 'image/jpeg')
      if (!data) {
        qrStatusBox.innerHTML = `<div class="status error">No QR code found in that photo. Try again with the code centered and in focus.</div>`
        return
      }
      let parsed: { u?: string; t?: string }
      try {
        parsed = JSON.parse(data)
      } catch {
        parsed = {}
      }
      if (!parsed.u || !parsed.t) {
        qrStatusBox.innerHTML = `<div class="status error">QR code found, but it wasn't a recognized pairing code.</div>`
        return
      }
      urlInput.value = parsed.u
      tokenInput.value = parsed.t
      qrStatusBox.innerHTML = `<div class="status ok">Bridge URL + token filled in from the QR code. Press Save & Test Connection below.</div>`
    } catch (err) {
      qrStatusBox.innerHTML = `<div class="status error">Scan failed: ${err instanceof Error ? err.message : String(err)}</div>`
    } finally {
      scanQrBtn.disabled = false
    }
  })

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true
    statusBox.innerHTML = `<div class="status">Testing…</div>`
    await saveConfig({
      bridgeUrl: urlInput.value,
      bridgeToken: tokenInput.value,
      sttProvider: providerSelect.value as SttProvider,
      sttKey: keyInput.value,
      sttRegion: regionInput.value,
    })
    const healthy = await checkHealth()
    if (!healthy) {
      statusBox.innerHTML = `<div class="status error">Could not reach the bridge. Check the URL, token, and that the bridge/tetherd containers are running.</div>`
      saveBtn.disabled = false
      return
    }
    statusBox.innerHTML = `<div class="status ok">Connected. Speech-to-text key saved (not verified until your first voice reply).</div>`
    saveBtn.disabled = false
  })
}
