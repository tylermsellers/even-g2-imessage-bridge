// Dispatches to whichever STT provider the user configured in Settings.

import type { SttProvider } from '../config'
import { getConfig } from '../config'
import { transcribeAzure } from './azure'
import { transcribeOpenAI } from './openai'
import { transcribeDeepgram } from './deepgram'
import { transcribeSoniox } from './soniox'
import type { Transcriber } from './types'

const PROVIDERS: Record<SttProvider, Transcriber> = {
  azure: transcribeAzure,
  openai: transcribeOpenAI,
  deepgram: transcribeDeepgram,
  soniox: transcribeSoniox,
}

export async function transcribe(pcm: Uint8Array, sampleRate: number): Promise<string> {
  const { sttProvider, sttKey, sttRegion } = getConfig()
  if (!sttProvider) throw new Error('No speech-to-text provider configured')
  if (!sttKey) throw new Error('No speech-to-text API key configured')
  const fn = PROVIDERS[sttProvider]
  if (!fn) throw new Error(`Unknown STT provider: ${sttProvider}`)
  return fn(pcm, sampleRate, { apiKey: sttKey, region: sttRegion })
}
