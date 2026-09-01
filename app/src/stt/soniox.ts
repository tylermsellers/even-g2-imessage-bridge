// Soniox — async REST pattern: upload the audio as a file, create a
// transcription job referencing it, poll until complete, then fetch the
// transcript. No synchronous option exists in Soniox's API, so this
// implements a bounded poll loop (~15s budget, matching the old app's
// transcribe timeout). https://soniox.com/docs/speech-to-text/api

import type { Transcriber } from './types'
import { pcm16ToWav } from './wav'

const POLL_INTERVAL_MS = 700
const POLL_BUDGET_MS = 15000

export const transcribeSoniox: Transcriber = async (pcm, sampleRate, { apiKey }) => {
  const authHeaders = { Authorization: `Bearer ${apiKey}` }
  const wav = pcm16ToWav(pcm, sampleRate)

  // 1. Upload the audio file.
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  const uploadRes = await fetch('https://api.soniox.com/v1/files', {
    method: 'POST',
    headers: authHeaders,
    body: form,
  })
  if (!uploadRes.ok) {
    throw new Error(`Soniox upload failed: ${uploadRes.status} ${await uploadRes.text().catch(() => '')}`)
  }
  const { id: fileId } = await uploadRes.json()

  // 2. Create the transcription job.
  const createRes = await fetch('https://api.soniox.com/v1/transcriptions', {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId, model: 'stt-async-preview' }),
  })
  if (!createRes.ok) {
    throw new Error(`Soniox transcription create failed: ${createRes.status} ${await createRes.text().catch(() => '')}`)
  }
  const { id: transcriptionId } = await createRes.json()

  // 3. Poll until complete or the time budget runs out.
  const deadline = Date.now() + POLL_BUDGET_MS
  let status = 'queued'
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const statusRes = await fetch(`https://api.soniox.com/v1/transcriptions/${transcriptionId}`, {
      headers: authHeaders,
    })
    if (!statusRes.ok) {
      throw new Error(`Soniox status check failed: ${statusRes.status}`)
    }
    const statusData = await statusRes.json()
    status = statusData.status
    if (status === 'completed') break
    if (status === 'error') throw new Error(statusData.error_message || 'Soniox transcription failed')
  }
  if (status !== 'completed') {
    throw new Error('Soniox transcription timed out')
  }

  // 4. Fetch the final transcript text.
  const transcriptRes = await fetch(`https://api.soniox.com/v1/transcriptions/${transcriptionId}/transcript`, {
    headers: authHeaders,
  })
  if (!transcriptRes.ok) {
    throw new Error(`Soniox transcript fetch failed: ${transcriptRes.status}`)
  }
  const transcriptData = await transcriptRes.json()
  return (transcriptData.text || '').trim()
}
