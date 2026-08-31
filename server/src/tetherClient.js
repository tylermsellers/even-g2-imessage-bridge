// Thin client for tetherd's JSON-line protocol over TCP.
//
// tetherd (https://github.com/zackb/tether) normally talks to its `tether`
// CLI over a UNIX socket, but also accepts the same line-delimited JSON
// protocol over plain TCP via `--host <ip>` (see src/cli/main.cpp upstream:
// "Connect over TCP to daemon ip instead of UNIX Socket", default port
// 5134). We reimplement that wire protocol directly here instead of
// shelling out to the CLI, so we get structured JSON back instead of
// CLI-formatted text.
//
// Protocol, reverse-engineered from tether's own CLI source
// (src/cli/main.cpp, functions print_bt_threads/print_bt_messages/
// send_bt_message):
//   - Open a TCP connection, write one JSON object per line (`\n`-terminated).
//   - Synchronous commands (bt_threads, bt_list_messages, bt_notifications,
//     bt_status, bt_devices, bt_connection) get exactly one JSON line back.
//   - bt_send_message is asynchronous: first send {"command":"subscribe"},
//     then the send command itself, then read the daemon's broadcast event
//     stream until a line with {"command":"bt_send_result", ...} arrives.
//
// This is a "beta" upstream feature (per tether's own README) and the exact
// event/field names below are inferred from the CLI's own parsing code, not
// from separate protocol documentation — if tetherd's wire format changes
// upstream, update the field names here to match.

import { connect } from "node:net";

const TETHER_HOST = process.env.TETHER_HOST || "127.0.0.1";
const TETHER_PORT = process.env.TETHER_PORT ? Number(process.env.TETHER_PORT) : 5134;
const CONNECT_TIMEOUT_MS = 4000;

/**
 * Opens a fresh TCP connection to tetherd, writes `lines` (already-JSON
 * strings, one command per call unless you need subscribe+command), and
 * resolves with every parsed JSON line the daemon sends back until
 * `isDone(parsedLine)` returns true (or the socket closes/times out).
 */
function talk(lines, isDone, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: TETHER_HOST, port: TETHER_PORT });
    let buffer = "";
    const results = [];
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      socket.end();
      resolve(results);
    };

    const timer = setTimeout(() => fail(new Error("Timed out talking to tetherd")), timeoutMs);
    timer.unref?.();

    socket.on("connect", () => {
      for (const line of lines) socket.write(line.endsWith("\n") ? line : line + "\n");
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!raw.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue; // ignore malformed/partial lines, matches upstream CLI behavior
        }
        results.push(parsed);
        if (isDone(parsed)) {
          clearTimeout(timer);
          succeed();
          return;
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      fail(err);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!settled) fail(new Error("tetherd closed the connection unexpectedly"));
    });
  });
}

/** One request, one response — used for every read-only bt_* command. */
async function request(command) {
  const results = await talk([JSON.stringify(command)], () => true, CONNECT_TIMEOUT_MS);
  return results[results.length - 1];
}

/** List iPhone message conversations (Bluetooth MAP threads). */
export async function listThreads() {
  const resp = await request({ command: "bt_threads" });
  return resp?.threads ?? [];
}

/** Read messages in one conversation. `thread` is tetherd's opaque thread key (e.g. "tel:+15551234567"). */
export async function listMessages(thread) {
  const resp = await request({ command: "bt_list_messages", thread });
  return resp?.messages ?? [];
}

/** See mirrored notifications from any app on the phone (ANCS, Beta upstream). */
export async function listNotifications() {
  const resp = await request({ command: "bt_notifications" });
  return resp?.notifications ?? [];
}

/** Current Bluetooth pairing/connection status, for a health/setup check. */
export async function btStatus() {
  return request({ command: "bt_status" });
}

/**
 * Send a reply into an existing thread. Sends over Bluetooth MAP —
 * this is a *real* SMS/iMessage send (same mechanism a car head unit uses),
 * not a Shortcuts/clipboard workaround. Asynchronous on the wire: we
 * subscribe first, then wait for the daemon's bt_send_result broadcast.
 */
export async function sendMessage(thread, body) {
  const results = await talk(
    [JSON.stringify({ command: "subscribe" }), JSON.stringify({ command: "bt_send_message", thread, body })],
    (line) => line?.command === "bt_send_result",
    10000 // sends can take longer than a simple read — the phone has to accept it
  );
  const result = results.find((r) => r?.command === "bt_send_result");
  if (!result) throw new Error("tetherd never confirmed the send");
  if (!result.success) throw new Error(result.message || "The message was not sent");
  return true;
}

export function tetherTarget() {
  return `${TETHER_HOST}:${TETHER_PORT}`;
}
