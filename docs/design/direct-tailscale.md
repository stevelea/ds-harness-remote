# Direct (Tailscale) transport

Status: implemented in the `feat/tailscale-direct` branch; Desktop plugin and Android
client integration follow the same wire format. Wire format is normative in
[protocol.md §28](../protocol.md#28-direct-tailscale-传输-v1).

## Why

DSH Remote normally needs a Remote Server for account authorization, presence and
signaling. When a Host and a Client are both members of the same Tailscale tailnet
they already share a private, mutually reachable network, so a relay is only used
for account bookkeeping. Direct mode removes the Server from the runtime path:

```text
+--------+        Tailscale (WireGuard) private network        +--------+
| Client |<----------- ws://studio.tail1234.ts.net:47400 ------>|  Host  |
+--------+            Noise IK inside the WebSocket             +--------+
```

The Host still never listens on a public interface: the opt-in listener binds only
the Tailscale addresses detected on the machine.

## Trust model

Direct mode does not add a second authorization system:

1. A device is authorized once by the existing Server flow (account membership +
   Host/Client mutual identity pinning). That is unchanged.
2. The Host stores authorized Clients in its local `IdentityStore` (`trusted-peers.json`).
   Direct mode reads exactly that list.
3. The Client stores the Host identity key in its local `IdentityStore`.
4. On a direct connection both sides run the same Noise IK suite
   (`Noise_IK_25519_ChaChaPoly_SHA256`) with the same prologue
   `createNoisePrologue(connectionId, hostDeviceId, clientDeviceId)`.
   The Client is the initiator, the Host the responder.
5. The Client verifies the responder static key against its pinned Host key; the
   Host verifies the initiator static key against the pinned Client key. A device
   that is unknown locally is rejected before Noise starts (`DIRECT_TRUST_REQUIRED`).
   Noise IK is the authoritative check: the `direct.hello` device id is only a
   lookup key and is not trusted until the transcript verifies it.

Consequences:

- A stolen Server login is not enough to reach a Host over Direct: the Host must
  also hold the Client's pinned identity key.
- No Server, no account credentials and no tokens participate in the direct
  connection. Nothing is sent to the Server at runtime.
- First-time pairing still requires the Server (or another out-of-band trust
  bootstrap). Direct mode is not a device-enrollment mechanism.

## Listener rules

- `direct.enabled` defaults to `false`.
- The listener only starts when Tailscale is detected *and* at least one tailnet
  address binds. Detection uses `tailscale status --json` (CLI at the known
  macOS/Linux/Windows locations or `DSH_TAILSCALE_BIN`) and falls back to scanning
  network interfaces for `100.64.0.0/10` and `fd7a:115c:a1e0::/48`.
- Wildcard, public, RFC1918 and link-local bind addresses are refused. Loopback is
  accepted only by the test seam; the production path never passes it.
- Default port `47400` (`direct.port`, or `DSH_REMOTE_DIRECT_PORT`); the endpoints
  shown in Host settings are the MagicDNS name (`*.ts.net`), Tailscale IPv4 and
  Tailscale IPv6 forms.
- WebSocket path is `/direct/v1`, text frames only. The listener never serves HTTP.

## Runtime limits

| Item | Limit |
| --- | --- |
| Direct frame | 1 MiB |
| `direct.hello` / `direct.ready` exchange | 5 s |
| Noise IK handshake | 15 s |
| Heartbeat | ping every 25 s |
| Idle close | no frame for 75 s |
| Active direct connections | 16 |
| Concurrent pre-handshake sockets | 8 |

Noise transport messages are already capped at 65,535 bytes, and the secure channel
fragments business messages before encryption, so normal RPC/stream traffic fits the
1 MiB frame bound. The authenticated channel reports mode `Direct`, which the workspace
upload limits treat like verified LAN/P2P (1 GiB).

## Negotiation in one connection

1. Client opens `ws://<endpoint>/direct/v1` and sends `direct.hello`
   (`connectionId`, `clientDeviceId`, `clientVersion?`, capabilities).
2. Host looks the client device id up in `IdentityStore`. Unknown → `direct.reject`
   with `DIRECT_TRUST_REQUIRED`, socket closed.
3. Host answers `direct.ready` (`connectionId`, `hostDeviceId`, `hostName`,
   `hostPlatform?`, capabilities, `maxFrameBytes`, `heartbeatIntervalMs`).
4. Noise IK step 1 (client) / step 2 (host) over `direct.handshake`.
5. Host registers the authenticated channel with its `ConnectionController`; the
   existing RPC router, permissions, terminal, CodeX/ACP and transfers are unchanged.
6. `direct.data` carries opaque Noise ciphertext. Both directions keep a per-direction
   counter that starts at 0 and must equal the Noise nonce; duplicates, gaps and
   oversized values fail closed.
7. `direct.ping` / `direct.pong` keep the carrier alive; either side closes with
   `direct.close` (or a WebSocket close) on timeout or protocol violation.

## Failure codes

| Code | Meaning |
| --- | --- |
| `DIRECT_TRUST_REQUIRED` | The client device id is not pinned locally on the Host. |
| `DIRECT_HANDSHAKE_FAILED` | Noise IK failed, timed out or arrived out of order. |
| `DIRECT_SECURE_CHANNEL_FAILED` | The secure channel rejected a message or counter. |
| `DIRECT_INVALID_FRAME` | Wrong frame for the connection phase, non-text frame, malformed JSON. |
| `DIRECT_TIMEOUT` | No `direct.hello` within the hello window. |
| `DIRECT_IDLE_TIMEOUT` | No frame within the idle window. |
| `DIRECT_BUSY` | Connection or pre-handshake limits reached. |
| `DIRECT_ADDRESS_NOT_TAILNET` | A detected bind address was not a tailnet address. |
| `DIRECT_BIND_FAILED` | The listener could not bind on any detected address. |

## Client UX

- Host settings show the enabled toggle, port, detected endpoints (copyable) and
  listener state/error. The hint says Clients must already be authorized through the
  Server.
- The Remote host picker shows saved direct hosts and lets the user save an endpoint
  for an already-pinned Host, then connect without the Server reachable. The carrier
  label is `Direct`. The Desktop client stores the canonical
  `ws(s)://host:port/direct/v1` URL in a 0600 `direct-hosts.json` next to the Client
  identity and re-checks the pinned Host key on every connect, so a rewritten file
  cannot redirect a session to another peer.
- Desktop Client: the Remote host picker lists saved direct hosts under "Direct
  (Tailscale)", and the settings page owns the Host listener toggle/port.
- Android: Home ⋮ menu → "Direct" opens a screen built only from locally trusted
  hosts and saved endpoints (available even when the Server refresh fails or the
  user is signed out), connects through the same `DirectTransport`/Noise path, and
  reports the carrier as `Direct`. Cleartext `ws://` is already permitted by the
  app's `usesCleartextTraffic` build property.
- Endpoint input accepts `host:port`, `ws://host:port`, `wss://host:port` and a
  MagicDNS name; only `100.64.0.0/10`, `fd7a:115c:a1e0::/48`, `*.ts.net` and
  loopback hosts pass validation. Paths, credentials, query parameters and public
  addresses are rejected. The Desktop parser defaults the port to 47400; Android
  requires an explicit port because the Host port is configurable and the saved
  value is always shown with it.

## Non-goals

- No automatic peer discovery: Tailscale provides the network, not DSH device
  identity or authorization. The user still supplies the Host endpoint once.
- No TLS requirement: WireGuard already protects the link and Noise IK protects the
  business channel end to end. `wss://` is accepted for deployments that terminate
  TLS on the tailnet.
- No Server protocol change: Direct frames are separate from the Server Control
  frames and never reach a Server. The existing LAN/P2P/TURN/Relay paths are
  untouched.
- No serverless enrollment, multi-account membership or account revocation
  propagation; authorization stays with the existing Server flow.

## Verification

Automated coverage in this branch:

- `packages/protocol/tests/direct-frame.test.ts` — frame schemas, canonical encoding,
  size/value limits, malformed input.
- `packages/webrtc/tests/direct-transport.test.ts` — hello/ready validation, reject
  codes, Noise step framing, direction counters, ping/pong, idle close.
- `packages/plugin/tests/direct-tailscale.test.ts` — address classification, endpoint
  parsing, CLI/interface detection.
- `packages/plugin/tests/direct-host-listener.test.ts` — real WebSocket + Noise IK
  happy path, untrusted client rejection before Noise, pinned-key mismatch, malformed
  frame close, Tailscale-not-detected state.

Not verified by automation (as of this branch): real two-machine Tailscale E2E,
Desktop UI and Android UI flows on a device, Windows/Linux listener binding, and
long-running idle/reconnect behavior. These remain manual acceptance items.
