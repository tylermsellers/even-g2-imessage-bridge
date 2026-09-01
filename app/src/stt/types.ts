// Shared interface every STT provider module implements.

export interface TranscribeOptions {
  apiKey: string
  region?: string // Azure only
}

export type Transcriber = (pcm: Uint8Array, sampleRate: number, opts: TranscribeOptions) => Promise<string>
