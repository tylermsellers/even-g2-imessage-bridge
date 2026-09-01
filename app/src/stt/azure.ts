// Azure Speech-to-Text, REST short-audio endpoint.
// https://learn.microsoft.com/azure/ai-services/speech-service/rest-speech-to-text

import type { Transcriber } from './types'
import { pcm16ToWav } from './wav'

export const transcribeAzure: Transcriber = async (pcm, sampleRate, { apiKey, region }) => {
  if (!region) throw new Error('Azure requires a region (e.g. "eastus")')
  const wav = pcm16ToWav(pcm, sampleRate)
  const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': apiKey,
      'Content-Type': `audio/wav; codecs=audio/pcm; samplerate=${sampleRate}`,
      Accept: 'application/json',
    },
    body: wav,
  })

  if (!res.ok) {
    throw new Error(`Azure STT failed: ${res.status} ${await res.text().catch(() => '')}`)
  }
  const data = await res.json()
  if (data.RecognitionStatus && data.RecognitionStatus !== 'Success') {
    throw new Error(`Azure STT: ${data.RecognitionStatus}`)
  }
  return (data.DisplayText || '').trim()
}
