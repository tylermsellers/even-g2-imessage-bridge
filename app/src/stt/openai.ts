// OpenAI Whisper / gpt-4o-transcribe, via the audio transcriptions endpoint.
// https://platform.openai.com/docs/api-reference/audio/createTranscription

import type { Transcriber } from './types'
import { pcm16ToWav } from './wav'

export const transcribeOpenAI: Transcriber = async (pcm, sampleRate, { apiKey }) => {
  const wav = pcm16ToWav(pcm, sampleRate)
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', 'gpt-4o-transcribe')

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })

  if (!res.ok) {
    throw new Error(`OpenAI STT failed: ${res.status} ${await res.text().catch(() => '')}`)
  }
  const data = await res.json()
  return (data.text || '').trim()
}
