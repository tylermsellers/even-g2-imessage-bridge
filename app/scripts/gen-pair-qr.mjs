#!/usr/bin/env node
// Generates a one-time "pairing" QR code that encodes your bridge URL +
// BRIDGE_TOKEN as compact JSON: {"u":"<bridgeUrl>","t":"<bridgeToken>"}.
// Scan it from the glasses app's phone Settings screen ("Scan Setup QR
// Code") to auto-fill both fields instead of copy/pasting the long token.
//
// Usage:
//   node scripts/gen-pair-qr.mjs
//     -> reads BRIDGE_URL from app.json's network whitelist (first entry
//        that looks like a Tailscale/Funnel host) and BRIDGE_TOKEN from
//        docker/bridge/.env, prints an ASCII QR code to the terminal.
//
//   node scripts/gen-pair-qr.mjs --url https://your-node.ts.net --token xxxx
//     -> use explicit values instead of auto-detecting.
//
//   node scripts/gen-pair-qr.mjs --out pair-qr.png
//     -> also save a scannable PNG file (in addition to the terminal QR).
//
// Run this on/near your docker host (wherever docker/bridge/.env lives),
// not on the phone. Treat the resulting QR code like a password: anyone
// who scans it gets read/reply access to your iMessages/SMS.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import QRCode from 'qrcode'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--url') out.url = argv[++i]
    else if (a === '--token') out.token = argv[++i]
    else if (a === '--out') out.out = argv[++i]
  }
  return out
}

function detectBridgeUrl() {
  const appJsonPath = path.join(appRoot, 'app.json')
  if (!existsSync(appJsonPath)) return null
  const appJson = JSON.parse(readFileSync(appJsonPath, 'utf8'))
  const networkPerm = (appJson.permissions || []).find((p) => p.name === 'network')
  const whitelist = networkPerm?.whitelist || []
  return whitelist.find((u) => /\.ts\.net$/.test(u)) || whitelist[0] || null
}

function detectBridgeToken() {
  const envPath = path.join(repoRoot, 'docker', 'bridge', '.env')
  if (!existsSync(envPath)) return null
  const contents = readFileSync(envPath, 'utf8')
  const match = contents.match(/^BRIDGE_TOKEN=(.+)$/m)
  return match ? match[1].trim() : null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const url = args.url || detectBridgeUrl()
  const token = args.token || detectBridgeToken()

  if (!url || !token) {
    console.error('Could not determine bridge URL and/or token.')
    if (!url) console.error('  - Pass --url <https://your-node.ts.net> or add it to app.json\'s network whitelist.')
    if (!token) console.error('  - Pass --token <value> or create docker/bridge/.env with BRIDGE_TOKEN=... (copy docker/bridge/.env.example).')
    process.exit(1)
  }

  const payload = JSON.stringify({ u: url, t: token })
  console.log(`Encoding pairing QR for ${url}\n`)

  const ascii = await QRCode.toString(payload, { type: 'terminal', small: true })
  console.log(ascii)

  if (args.out) {
    await QRCode.toFile(args.out, payload, { width: 512, margin: 2 })
    console.log(`Saved PNG: ${args.out}`)
  }

  console.log('Scan this from the glasses app\'s phone Settings screen: "Scan Setup QR Code".')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
