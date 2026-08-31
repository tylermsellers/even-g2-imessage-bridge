// Thin client for tetherd's local control protocol, over its UNIX socket.
//
// IMPORTANT (discovered by reading tetherd's own docs/PROTOCOL.md upstream,
// after this bridge's first deploy attempt got ECONNRESET talking TCP):
// tetherd's TCP listener (0.0.0.0:5134, TLS + fingerprint-pinned pairing)
// is ONLY for clipboard sync / file transfer / OTP relay with the iPhone
// companion app and browser/mail extensions. Per the daemon's own docs:
// "[Bluetooth commands] are local-only: nothing here is reachable over TCP,
// because everything here is personal data." All `bt_*` commands (threads,
// messages, send, notifications, status) are answered ONLY on the local
// UNIX socket (`$XDG_RUNTIME_DIR/tether/tetherd.sock`, normally
// /run/user/0/tether/tetherd.sock as root) - by design, so a message-reading
// capability is never reachable over any network, TLS or not.
//
// This container therefore reaches tetherd over that UNIX socket, shared
// via a bind-mounted volume with the tetherd container (see
// docker-compose.yml: both containers mount the same host directory at
// /run/user/0/tether). tetherd's TCP port is never used or exposed by this
// bridge at all.
//
// Protocol: newline-delimited JSON, one command object per line, same as
// tetherd's own docs/PROTOCOL.md sections 4 and 6 describe:
//   - Synchronous commands (bt_status, bt_list_devices, bt_connection,
//     bt_list_threads, bt_list_messages, bt_list_notifications,
//     bt_diagnostics) get exactly one JSON line back, on the command's own
//     `bt_*` response name (e.g. bt_list_threads -> {"command":"bt_threads",...}).
//   - bt_send_message is asynchronous: send {"command":"subscribe"} first,
//     then the send command, then read the daemon's broadcast event stream
//     until a line with {"command":"bt_send_result", ...} arrives.

import { connect } from "node:net";

const TETHER_SOCKET = process.env.TETHER_SOCKET || "/run/user/0/tether/tetherd.sock";
const CONNECT_TIMEOUT_MS = 4000;

/**
 * Opens a fresh connection to tetherd's UNIX socket, writes `lines`
 * (already-JSON strings, one command per call unless you need
 * subscribe+command), and resolves with every parsed JSON line the daemon
 * sends back until `isDone(parsedLine)` returns true (or the socket
 * closes/times out).
 */
function talk(lines, isDone, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: TETHER_SOCKET });
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
  const resp = await request({ command: "bt_list_threads" });
  return resp?.threads ?? [];
}

/** Read messages in one conversation. `thread` is tetherd's opaque thread key (e.g. "tel:+15551234567"). */
export async function listMessages(thread) {
  const resp = await request({ command: "bt_list_messages", thread });
  return resp?.messages ?? [];
}

/** See mirrored notifications from any app on the phone (ANCS). */
export async function listNotifications() {
  const resp = await request({ command: "bt_list_notifications" });
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
  return TETHER_SOCKET;
}
