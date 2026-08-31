# Tailscale Funnel (public exposure of the bridge)

## What this does

Runs the official `tailscale/tailscale` container in `network_mode: host`
alongside `tetherd` and `bridge`, and uses a declarative `TS_SERVE_CONFIG` to:

1. Join your tailnet as a persistent node (`g2-imessage-bridge`).
2. Terminate TLS on port 443 with a Tailscale-issued cert for
   `<node>.<tailnet>.ts.net`.
3. Reverse-proxy all traffic to `http://127.0.0.1:8787` — the `bridge`
   service, which is the *only* thing ever exposed. `tetherd`'s raw TCP
   protocol (port 5134) is never proxied or Funneled; it's reachable only
   from `bridge` itself, over loopback, since both containers share the
   host's network namespace.
4. Enable Funnel (public internet access, not just tailnet-private) for that
   one proxied path.

The bridge still requires `BRIDGE_TOKEN` (see `../bridge/.env.example`) on
every request regardless of Funnel — Funnel only controls *reachability*,
not *authorization*. Losing the token is the actual blast-radius boundary
here, not the Funnel toggle.

## One-time setup

1. Generate an auth key at
   https://login.tailscale.com/admin/settings/keys with:
   - **Tagged** (e.g. `tag:server`) — required for a persistent server node,
     and typically required by your tailnet's ACL policy to grant Funnel
     access to a non-personal device.
   - **Reusable** — so the key still works if this container is ever
     recreated from scratch.
   - **Not ephemeral** — ephemeral nodes are auto-removed from the tailnet
     when they go offline, which would force re-auth on every container
     restart. This is a persistent home-server node, not a CI runner.
   - A finite expiry (e.g. 90 days) rather than never-expiring.
2. On `docker-host`, create `./tailscale/.env` (gitignored, never commit):
   ```
   TS_AUTHKEY=tskey-auth-xxxxxxxxxxxx
   ```
3. Your tailnet's ACL policy (admin console -> Access Controls) needs a
   grant allowing this tagged node to use Funnel, e.g.:
   ```json
   {
     "nodeAttrs": [
       { "target": ["tag:server"], "attr": ["funnel"] }
     ]
   }
   ```
4. `docker compose up -d tailscale` (after `bridge` and `tetherd` are
   already up). Check it registered: `docker exec g2-tailscale tailscale status`.
5. Find your Funnel URL: `docker exec g2-tailscale tailscale funnel status`
   — it'll be `https://g2-imessage-bridge.<your-tailnet>.ts.net`.
6. Verify from anywhere (not just the LAN):
   ```sh
   curl -H "x-bridge-token: <your BRIDGE_TOKEN>" \
     https://g2-imessage-bridge.<your-tailnet>.ts.net/api/health
   ```

## Why the bridge, not tetherd, is what's exposed

`tetherd` speaks a raw line-delimited JSON TCP protocol with no
authentication of its own (see `../tetherd`'s docs/upstream README) — it
trusts whatever can reach its socket. `bridge` is the only layer with a
shared-secret token check, input validation, and a narrow, purpose-built set
of endpoints (list threads, list messages, send). Funneling `tetherd`
directly would mean anyone who found the URL could read/send iMessages with
zero authentication.
