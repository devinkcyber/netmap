# netmap-sliver-bridge

A tiny **localhost-only, read-only** bridge between a running [Sliver](https://github.com/BishopFox/sliver)
C2 server and the netmap web app. netmap can't speak Sliver's gRPC/mTLS from a
browser, so this process holds the operator credentials, connects to Sliver, and
exposes a small JSON API that netmap consumes.

**Milestones 1–2** implement connection, read-only endpoints, and a live event
WebSocket. There are no implant-interaction endpoints — the read-only scope is
enforced by their absence.

## Requirements
- Go **1.25+** (the Sliver module sets that floor; with `GOTOOLCHAIN=auto`, the
  default, Go fetches the right toolchain automatically).
- A Sliver **operator config** (`.cfg`) — generate one on the Sliver server:
  ```
  sliver > new-operator --name <you> --lhost <server-ip>
  # or, older: multiplayer / new-operator, then copy the generated .cfg
  ```
  Put it at `bridge/operator.cfg` (git-ignored).

## Run
```bash
cd bridge
go run . --config operator.cfg
```
On startup it prints a **BRIDGE TOKEN** — paste that into netmap's Sliver
connection settings. Flags:

| flag | default | meaning |
| --- | --- | --- |
| `--config` | `operator.cfg` | path to your Sliver operator `.cfg` |
| `--listen` | `127.0.0.1:8888` | loopback bind address (refuses non-loopback) |
| `--allow-origin` | `http://localhost:5173` | the only browser origin allowed to call it |
| `--token` | *(auto-generated)* | bearer token netmap must send |

Or start it alongside netmap via the `sliver-bridge` entry in
`.claude/launch.json` (uses a fixed dev token `netmap-dev`).

## API
All data endpoints require `Authorization: Bearer <token>`. Responses for
`/sessions` and `/beacons` are Sliver's protobuf messages marshalled to JSON with
the original field names (version-robust), e.g. `{"Sessions":[{"Hostname":…,"OS":…}]}`.

| method | path | auth | returns |
| --- | --- | --- | --- |
| GET | `/health` | none | `{"status":"ok","sliverConnected":bool}` |
| GET | `/sessions` | token | `{"Sessions":[ …clientpb.Session… ]}` |
| GET | `/beacons` | token | `{"Beacons":[ …clientpb.Beacon… ]}` |
| GET | `/events` | token via `?token=` | WebSocket (see below) |

### `/events` WebSocket
Browsers can't set headers on a WS handshake, so authenticate with a query param:
`ws://127.0.0.1:8888/events?token=<token>`. The first message is a **snapshot**;
after that you get one **event** per Sliver event (session/beacon connect,
disconnect, check-in, …), reconnecting to Sliver automatically if the stream drops.

```jsonc
// first message
{"kind":"snapshot","sessions":{"Sessions":[…]},"beacons":{"Beacons":[…]}}
// subsequent messages
{"kind":"event","event":{"EventType":"session-connected","Session":{…}}}
```

## Verify (against a live Sliver server)
```bash
TOK=<token printed on startup>
curl -s 127.0.0.1:8888/health | jq            # {"sliverConnected":true,...}
curl -s -H "Authorization: Bearer $TOK" 127.0.0.1:8888/sessions | jq '.Sessions[].Hostname'
curl -s -H "Authorization: Bearer $TOK" 127.0.0.1:8888/beacons  | jq '.Beacons | length'

# live events — no extra install needed, use the built-in viewer:
go run ./cmd/wstest --token "$TOK" --url ws://127.0.0.1:8888/events
# → prints the snapshot, then an event each time you generate/kill an implant
# (or, if you have it: websocat "ws://127.0.0.1:8888/events?token=$TOK" -H "Origin: http://localhost:5173")
```

## Security
- Binds to loopback only; requires a bearer token; allowlists one browser Origin;
  rejects non-loopback `Host` headers (DNS-rebinding defense).
- Treat `operator.cfg` as a secret (it contains your operator mTLS key). It's
  git-ignored and never logged.

## Design notes
- mTLS matches the Sliver client: the server cert is CA-signed but its SAN doesn't
  match `lhost`, so we disable hostname verification and validate the chain against
  the config's CA ourselves (`InsecureSkipVerify` + a custom `VerifyPeerCertificate`).
- The operator token is sent as gRPC per-RPC metadata (`Authorization: Bearer …`).
- Endpoints proxy Sliver protobufs straight to JSON via `protojson` (no hand-mapped
  DTOs), so field changes across Sliver versions don't break the bridge.

Pinned/tested against **Sliver v1.7.3**.
