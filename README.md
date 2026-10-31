# Jigsaw Together

A locally hosted, two-player jigsaw game built with Svelte 5 / SvelteKit, Three.js, Socket.IO and a server-authoritative puzzle engine.

## Run

Requires Node.js 20.19+ (Node 22 LTS recommended).

```sh
npm install
npm run dev
```

Open http://localhost:3000. Choose the included artwork or upload a JPEG, PNG or WebP (12 MB maximum), choose 16, 36 or 100 pieces, then share the room link. A room supports two connected players. A single player can play too.

For a production build:

```sh
npm run build
npm start
```

`PORT` defaults to 3000 and `HOST` to `0.0.0.0`. The custom Node server serves SvelteKit and Socket.IO on the same port in both modes.

## Play

Drag pieces to move them. Drop near a correctly oriented neighbor to join them into one cluster. Drop a cluster near its position in the central board to place it. Placed pieces stay fixed. Scroll or use the toolbar to zoom; Fit restores the camera. When rotation is enabled, press R while holding a piece to turn it 90°. Reference shows the picture; Edges only hides loose interior pieces. The source image is center-cropped to a square.

Colored pointers show the other player. The first successful pickup locks the entire group. Disconnecting releases locks, and reconnecting restores authoritative state. Room settings, images and puzzle progress persist in `data/`; each completed drop saves the full room collection using serialized atomic file replacement. Active undropped movements may be lost if the process crashes. Back up `data/` to move or retain games. The lobby lists saved puzzles on this server.

## Secondary connection options: direct UDP and WebRTC

The ordinary HTTP/Socket.IO server remains the default. For peer connectivity, run the app on both computers, then click **Connection options** in the lobby or open http://localhost:3002. This is a separate, loopback-only controller. Set `PEER_CONTROL_PORT` to change its port, or `0` to disable it. Allow Node through your OS firewall for the UDP listening port you choose. Both players use the same private connection key; generate it on one computer and share it privately. The host retains authoritative state and saves.

| Method     | What to enter                                           | How it connects                                                                                 |
| ---------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Direct UDP | Friend's public IPv4/IPv6 address and UDP port          | Repeated simultaneous punching, authenticated handshake, encrypted reliable delivery            |
| WebRTC     | Same reachable rendezvous-server URL and connection key | Encrypted automatic SDP/ICE exchange, ICE route selection, reliable ordered data channel        |
| Try both   | Rendezvous URL; optionally public UDP address/port      | Both methods run; the host selects the first working route and can switch to a connected backup |

### Direct UDP

1. On one computer choose **Host**, **Direct UDP**, local UDP port `5000`, your friend's public address and peer UDP port `5001`.
2. On the other choose **Guest**, **Direct UDP**, local UDP port `5001`, the host's public address and peer UDP port `5000`.
3. Enter the same connection key on both and click **Start connecting** on both computers. Leave them running together while they punch.
4. After the two-way authenticated handshake completes, the guest clicks **Open the game**. This opens http://localhost:3001, which tunnels to the host's game. Choose the host's puzzle in that lobby; the host plays on http://localhost:3000. You can also paste the host's invite into the **Have an invite?** field in the tunneled lobby; it extracts the room ID and opens it on the correct forwarded origin. Clicking a host's localhost URL directly on the guest computer opens the guest's own app, so use the tunneled lobby.

The public address must match the selected IP family on both sides. If NAT changes the external UDP port, use the externally mapped port, which can differ from the listening port. The bridge learns authenticated peer endpoint changes from incoming traffic, but cannot discover an unreachable initial external mapping using only an IP address. No port scanning or native TCP punching is performed. Direct connectivity depends on the actual NAT and firewall behavior; the UI reports a connection only after a valid handshake.

The same UDP socket stays bound throughout the session. Startup and reconnect probes repeat every 250 ms; keep-alives run every 2 seconds, and 12 seconds without authenticated traffic triggers a new handshake. The encrypted transport uses sequence numbers, selective acknowledgements, duplicate suppression, bounded reorder buffers, adaptive retransmission, a congestion window and bounded queues. It carries multiplexed TCP streams for HTTP, image uploads/downloads and WebSockets. It accepts only the configured peer key and encrypts packets with AES-256-GCM. Keys remain in memory and are never written to configuration or logs.

Successful UDP punching does **not** open a native TCP mapping. The local browser speaks TCP to the local bridge, the bridge carries those bytes reliably over UDP, and the host bridge opens a local TCP connection to the game. [RFC 5128](https://www.rfc-editor.org/rfc/rfc5128.html) describes UDP and TCP traversal separately.

### WebRTC / automatic ICE

WebRTC runs in the Connection options browser tab, so keep that tab open on both computers. Choose **WebRTC** or **Try both**, use opposite roles, the same key, and the same rendezvous URL. ICE candidates and offers/answers are exchanged automatically. No manual peer IPs or candidate copy/paste is needed. The browser's ordered, reliable SCTP data channel carries the same TCP tunnel, encrypted by WebRTC's DTLS transport; signaling is additionally encrypted with a key derived from the private connection key.

A small standalone rendezvous server is included:

```sh
npm run signal
```

It listens on `SIGNAL_PORT` (default `8787`) and `SIGNAL_HOST` (default `0.0.0.0`). Run it on a computer/server both players can already reach. On the same machine, `http://localhost:8787` is useful for testing; two different computers' `localhost` URLs do not refer to the same server. For remote use, expose this service through an HTTPS reverse proxy that forwards WebSocket upgrades, and enter its HTTPS origin on both computers. The controller is loaded from loopback HTTP, which browsers treat as a secure context for WebRTC/WebCrypto.

The rendezvous server pairs one host and one guest for a key-derived session ID, forwards opaque encrypted signaling, rate-limits signaling messages and removes empty sessions. It never receives game traffic, images or the private key. No publicly hosted rendezvous or TURN service is provisioned by this repository. STUN defaults are configurable in the UI; add a TURN URL and credentials for networks where ICE cannot establish a direct path. TURN relays game traffic when selected. See the official [peer connection](https://webrtc.org/getting-started/peer-connections) and [data channel](https://webrtc.org/getting-started/data-channels) guides.

### Recovery and scope

Route failures close the affected TCP streams. Socket.IO then reconnects and reloads authoritative room state; a route switch is not a seamless continuation of an existing native TCP session. A document load or in-progress upload may need retrying. UDP re-punching and WebRTC renegotiation run automatically; the UI shows the active route, probe status, UDP RTT and retransmission count. Reopening Connection options after a WebRTC tab closes requires starting it again. Direct UDP continues without that tab.

The guest's forwarded port binds only to loopback. The tunnel targets only the host's game port, never the separate management port or arbitrary destinations. This is an experimental private-friend tunnel; it grants access to the host's game lobby and saved puzzles, and is not a hardened public VPN or general-purpose proxy. The normal game server connection remains available independently.

## Verification

```sh
npm run check
npm test
npm run build
```

Tests cover deterministic generation, neighbor validation, rotation, cluster merging, board completion, geometry validity and a real Socket.IO two-client lock race, unauthorized movement rejection, drop synchronization and reconnect recovery. Peer tests exercise packet loss, duplication, reordering, timeouts, re-punching, wrong-key rejection, agreed route election/failover, HTTP binary transfers and authoritative Socket.IO gameplay through the UDP tunnel, plus rendezvous pairing.

## Layout

- `src/lib/game`: renderer-independent puzzle transforms/snapping and deterministic interlocking geometry.
- `src/lib/renderer/Scene.ts`: beveled 3D pieces, image UVs, shadows, picking, local dragging and remote interpolation.
- `server`: HTTP uploads, room persistence and authoritative networking.
- `server/peer`: reliable encrypted UDP, browser WebRTC bridge, TCP multiplexing, route election, local management UI and standalone rendezvous service.
- `shared/types.ts`: shared state and transform protocol.

The included landscape is a local SVG asset. Rendering requires WebGL. UI fonts have system fallbacks when Google Fonts is unavailable. Local/LAN play and manual direct UDP do not require a database or external hosting. Automatic remote WebRTC pairing needs a reachable rendezvous service and may also need TURN.
