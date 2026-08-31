// HTTP relay in front of tetherd's raw JSON-line TCP protocol.
//
// This is the only piece of the stack ever exposed beyond the homelab LAN
// (via Tailscale Funnel, configured in docker-compose.yml) — tetherd's own
// TCP port (5134) stays tailnet/LAN-only. Same shared-secret token pattern
// as g2-protonmail's and Copilot Terminal's relays, since this is a much
// bigger blast radius if leaked (full iMessage/SMS read+reply).

import "dotenv/config";
import express from "express";
import cors from "cors";
import { listThreads, listMessages, sendMessage, btStatus, tetherTarget } from "./tetherClient.js";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const TOKEN = process.env.BRIDGE_TOKEN || null;

app.use((req, res, next) => {
  if (!TOKEN) return next();
  const supplied = req.header("x-bridge-token") || req.query.token;
  if (supplied !== TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

app.get("/api/health", async (_req, res) => {
  try {
    const status = await btStatus();
    res.json({ ok: true, tether: tetherTarget(), status });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.get("/api/threads", async (_req, res) => {
  try {
    res.json({ threads: await listThreads() });
  } catch (err) {
    res.status(500).json({ threads: [], error: err.message });
  }
});

app.get("/api/messages/:thread", async (req, res) => {
  try {
    const thread = decodeURIComponent(req.params.thread);
    res.json({ messages: await listMessages(thread) });
  } catch (err) {
    res.status(500).json({ messages: [], error: err.message });
  }
});

app.post("/api/send", async (req, res) => {
  const { thread, body } = req.body || {};
  if (!thread || !body) {
    res.status(400).json({ error: "thread and body are required" });
    return;
  }
  try {
    await sendMessage(thread, body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[g2-imessage-bridge] listening on http://127.0.0.1:${PORT} -> tetherd unix socket @ ${tetherTarget()}`);
  if (!TOKEN) {
    console.warn("[g2-imessage-bridge] BRIDGE_TOKEN not set — running with no auth. Set it before any Funnel exposure.");
  }
});
