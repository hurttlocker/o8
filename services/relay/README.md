# o8 relay

The **zero-knowledge off-network relay** for o8's mobile window. A long-lived
WebSocket concentrator that lets a paired phone reach its Mac when they're not on the
same LAN — **without** the relay ever reading a frame body, holding a session key, or
terminating E2EE. It forwards opaque ciphertext. Its transient routing knowledge
now includes mobile routing IDs plus signed account/machine identity for the
connect channel; it still stores no database or prompt content.

Full design + frozen wire contract: [`docs/relay-v1-design.md`](../../docs/relay-v1-design.md).

## Topology

```
Mac connector ──outbound wss──► relay.o8.run ◄──wss── phone
   /mac (Bearer plan-JWT + x-o8-routing-id)   /device/{routingId} (no auth at the relay)

Machine connector ──outbound wss──► relay.o8.run ◄──wss── authenticated web edge
   /machine (Bearer relay ticket + x-o8-machine-id)   /web/machine/{machineId}
```

- **`/mac`** — the desktop connector dials OUT. The relay verifies the plan-JWT
  signature + `resolveFlags(plan)['relay.offNetwork']` (else close **4409**). One socket
  per routingId; newest supersedes.
- **`/device/{routingId}`** — the phone. No auth at the relay (the device registry is on
  the Mac — that's the zero-knowledge point). Rate-limited only: ≤8 pending un-authed
  sockets + ≤30 connects/min per routingId; 10s handshake deadline.
- **`/machine`** — the connect channel. It verifies the machine-scoped EdDSA
  ticket, its `o8-relay` audience, expiry, and machine header equality. This
  channel is separate from the paid mobile entitlement and therefore supports
  registered free-plan machines.
- **`/web/machine/{machineId}`** — the server-side website edge. The relay sends
  its bearer to the license server and accepts the socket only when the
  account-scoped machine list contains the addressed machine. No client-supplied
  account ID participates in routing.
- Data frames are opaque `{sid, seq, payload}` — forwarded byte-for-byte. Control frames
  (`presence`, `devices`, `push-req`, `mux-open/close`, `mux-ready`) carry zero user content.
- Close codes: **4401/4403** pass through from the Mac unchanged; **4408** `mac_offline`,
  **4409** `entitlement_lapsed` are relay-origin.

## Layout (mirrors `services/license-server`)

| File | What |
|---|---|
| `src/index.ts` | Hono `/health` + ws upgrade routing (the only place env loads) |
| `src/relay.ts` | `RelayServer` — concentrator: presence, supersede, mac-offline hold, push-req |
| `src/routing.ts` | pure `RoutingTable` + `RateLimiter` |
| `src/protocol.ts` | frozen wire codec + close codes |
| `src/plan-jwt.ts` | pure EdDSA plan-JWT verify (key injected) |
| `src/machine-ticket.ts` | pure EdDSA machine relay-ticket verify |
| `src/license-client.ts` | server-side ownership checks + authenticated heartbeats |
| `src/entitlement.ts` | **copy #3 of the twin flag map** — keep in lockstep (see header) |
| `src/apns.ts` | HTTP/2 APNs **alert** sender (transient token, never stored) |
| `src/env.ts` | boot-time env validation |
| `src/attach.ts` | pure ws-upgrade router (shared by index + the e2e) |

## Develop

```bash
npm install
npm run typecheck        # tsc --noEmit
npm run contract-test    # pure-logic invariants (routing, supersede, rate limits, mux, JWT)
npm run verify-e2e       # spins the real relay + fake Mac/phone, drives the full contract
npm run dev              # tsx watch (needs LICENSE_PUBLIC_KEY in .env — see .env.example)
```

## Deploy

Separate Railway service — **Q-gated**. See [`DEPLOY-CHECKLIST.md`](./DEPLOY-CHECKLIST.md).
