// Deepgram — accepts raw linear16 PCM directly, no WAV wrapper or
// multipart form needed. Simplest of the four providers, and synchronous.
// https://developers.deepgram.com/reference/speech-to-text-api/listen

import type { Transcriber } from './types'

export const transcribeDeepgram: Transcriber = async (pcm, sampleRate, { apiKey }) => {
  const url = `https://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=${sampleRate}&channels=1&smart_format=true`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'audio/raw',
    },
    body: pcm as BodyInit,
  })

  if (!res.ok) {
    throw new Error(`Deepgram STT failed: ${res.status} ${await res.text().catch(() => '')}`)
  }
  const data = await res.json()
  const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript
  return (transcript || '').trim()
}
