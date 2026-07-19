# netmap-vault-bridge

A tiny **localhost-only** helper that reads and writes an Obsidian vault directory
and exposes it to netmap as a small JSON API.

netmap normally edits your vault straight from the browser with the **File System
Access API** — but that API only ships in Chromium browsers (Chrome, Edge, Brave,
Arc). On **Firefox and Safari** there's no way for a web page to hold a live handle
to a real folder, so netmap talks to this helper instead. **You don't need it on a
Chromium browser.**

## Requirements
- Go **1.25+** (`GOTOOLCHAIN=auto`, the default, fetches the right toolchain).

## Run
```bash
cd bridge-vault
go run . --vault /path/to/your/Obsidian/vault
```
On startup it prints a **BRIDGE TOKEN**. In netmap, click **Connect vault** (on a
non-Chromium browser this opens the bridge dialog; on Chromium add `?vaultbridge`
to the URL to force it), then paste the URL and token.

| flag | default | meaning |
| --- | --- | --- |
| `--vault` | *(required)* | path to your Obsidian vault directory |
| `--listen` | `127.0.0.1:8899` | loopback bind address (refuses non-loopback) |
| `--allow-origin` | `http://localhost:5173` | the only browser origin allowed to call it |
| `--token` | *(auto-generated)* | bearer token netmap must send |

For local dev you can start it alongside netmap via the `vault-bridge` entry in
`.claude/launch.json` (fixed dev token `netmap-dev`, pointed at `./demo-vault`).

## API
All data endpoints require `Authorization: Bearer <token>`. Paths are vault-relative
with forward slashes.

| method | path | returns |
| --- | --- | --- |
| GET | `/health` | `{"status":"ok","vault":"<name>"}` (no token) |
| GET | `/vault` | `{"name":"<vault dir name>"}` |
| GET | `/notes` | `{"notes":[{"path":…,"head":<first 2 KB>}]}` — every `*.md`, dotfolders skipped |
| GET | `/file?path=…` | note text |
| PUT | `/file?path=…` | write note text (body = content; parent dirs created) |
| GET | `/blob?path=…` | attachment bytes |
| PUT | `/blob?path=…` | write attachment bytes |

## Security
- Binds to loopback only; requires a bearer token (constant-time compare); allowlists
  one browser Origin; rejects non-loopback `Host` headers (a DNS-rebinding defence).
- **Every path is sandboxed to the vault root** — `..`, absolute paths, etc. can't
  escape the directory you pointed it at.
- Writes are capped at 64 MiB per request.
- This is a read/write bridge (unlike the read-only Sliver bridge) — point it only at
  a vault you're willing to let the netmap page in your browser edit, and keep the
  token to yourself.

## Notes & caveats
- Symlinks inside the vault that point outside it are followed by the OS; the path
  sandbox blocks `..`/absolute escapes but not a pre-existing symlink. Don't put
  escaping symlinks in a vault you expose.
- Frontmatter parsing, note matching, and templating all happen in netmap — the
  bridge is a dumb, sandboxed file API.
