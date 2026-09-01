// Shared configuration: the bridge connection (Tailscale Funnel URL +
// BRIDGE_TOKEN) and the user's chosen speech-to-text provider + their own
// API key for it. Persisted via persistentStorage.ts (bridge.getLocalStorage/
// setLocalStorage, mirrored to window.localStorage) — same proven pattern as
// oura-glance-g2's src/lib/persistentStorage.ts, which exists specifically
// because bridge storage alone isn't reliably durable across app restarts on
// the real Flutter WebView host, and is reset entirely on a simulator
// process restart.
//
// Bring-your-own-key STT: the user pastes their own API key for whichever
// provider they pick (Azure, OpenAI, Deepgram, or Soniox). Keys are sent
// directly from the phone to the provider's own API for transcription —
// they never pass through our bridge or tetherd.

import { getPersistent, setPersistent } from './persistentStorage'

export type SttProvider = 'azure' | 'openai' | 'deepgram' | 'soniox'

const KEY_BRIDGE_URL = 'g2im.bridgeUrl'
const KEY_BRIDGE_TOKEN = 'g2im.bridgeToken'
const KEY_STT_PROVIDER = 'g2im.sttProvider'
const KEY_STT_KEY = 'g2im.sttKey'
const KEY_STT_REGION = 'g2im.sttRegion' // Azure only

export interface AppConfig {
  bridgeUrl: string
  bridgeToken: string
  sttProvider: SttProvider | ''
  sttKey: string
  sttRegion: string
}

let cached: AppConfig = {
  bridgeUrl: '',
  bridgeToken: '',
  sttProvider: '',
  sttKey: '',
  sttRegion: '',
}

export function isBridgeConfigured(): boolean {
  return !!cached.bridgeUrl
}

export function isSttConfigured(): boolean {
  return !!cached.sttProvider && !!cached.sttKey
}

export function getConfig(): AppConfig {
  return cached
}

export async function loadConfig(): Promise<AppConfig> {
  const [url, token, provider, key, region] = await Promise.all([
    getPersistent(KEY_BRIDGE_URL),
    getPersistent(KEY_BRIDGE_TOKEN),
    getPersistent(KEY_STT_PROVIDER),
    getPersistent(KEY_STT_KEY),
    getPersistent(KEY_STT_REGION),
  ])
  cached = {
    bridgeUrl: (url || '').trim().replace(/\/+$/, ''),
    bridgeToken: (token || '').trim(),
    sttProvider: (provider || '') as SttProvider | '',
    sttKey: (key || '').trim(),
    sttRegion: (region || '').trim(),
  }
  return cached
}

export async function saveConfig(next: Partial<AppConfig>): Promise<void> {
  cached = { ...cached, ...next }
  await Promise.all([
    setPersistent(KEY_BRIDGE_URL, cached.bridgeUrl),
    setPersistent(KEY_BRIDGE_TOKEN, cached.bridgeToken),
    setPersistent(KEY_STT_PROVIDER, cached.sttProvider),
    setPersistent(KEY_STT_KEY, cached.sttKey),
    setPersistent(KEY_STT_REGION, cached.sttRegion),
  ])
}
