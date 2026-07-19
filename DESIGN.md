# netmap — design notes

## Architecture

```
src/
  types.ts               internal model (Host, Port) + osFamily/subnet helpers
  lib/parseNmap.ts       nmap -oX → model, via native DOMParser; defensive on optional data
  lib/topology.ts        edge derivation: traceroute chaining / subnet grouping
  lib/vault.ts           File System Access API: handle persistence (IndexedDB),
                         vault index, read/write/create, frontmatter helpers, note template
  lib/markdown.ts        marked + DOMPurify, [[wikilink]] → interceptable anchors
  lib/ad.ts              Active Directory heuristics: DC detection, AD role, AD services
  lib/bloodhound.ts      BloodHound CE deep-linking: host→node name / object ID, URL template
  lib/creds.ts           match the user/credential list to scanned hosts
  lib/encodings.ts       color scale + DC sizing, status-ring colors, legends
  lib/sliver.ts          Sliver C2 overlay client (WebSocket to the optional bridge)
  lib/bus.ts             tiny event bus for graph commands + localStorage helpers
  store.ts               zustand store: scan, settings, filters, selection, vault status
  components/
    Graph.tsx            Cytoscape rendering, layouts, interactions, position persistence,
                         filter fading, tooltip, PNG export
    TopBar.tsx           import / vault / topology / layout / search / export / theme
    LeftRail.tsx         filters, encodings, legend, BloodHound + vault tools
    NotePanel.tsx        host header, status workflow, note editor/preview, BloodHound link
    PortsTable.tsx       sortable ports/services table
    ImportModal.tsx      drag-drop / picker / paste / sample
    UsersModal.tsx       AD user list: import user.txt, assign passwords, export
    SliverModal.tsx      Sliver C2 connection + live session/beacon list
    BeaconTimer.tsx      per-beacon check-in countdown
bridge/                  optional read-only Go bridge to a Sliver C2 server (see bridge/README.md)
```

## Design decisions

- **Cytoscape.js used directly** rather than through `react-cytoscapejs` — the
  wrapper is thinly maintained and gets in the way of imperative needs (layout
  runs, batch updates, position restore). A single `Graph.tsx` owns the instance
  behind a ref.
- **Editor is a mono textarea + rendered preview** (marked + DOMPurify with
  wikilink handling) instead of a heavyweight markdown-editor component — it's
  lighter, avoids CSS-theme fights, and editing raw markdown is idiomatic for
  Obsidian users. Swapping in CodeMirror later only touches `NoteSection`.
- **Vault access is isolated behind a `VaultBackend` interface in `lib/vault.ts`.**
  Two backends implement it: the File System Access API (Chromium, zero-setup) and an
  HTTP client for the local `bridge-vault/` helper (Firefox/Safari). Everything above
  the backend — the note index, matching, templating, frontmatter surgery — is shared,
  so the browser-specific dependency lives in exactly one small class.
- **Frontmatter edits are surgical** — a single field is replaced in place, so the
  rest of the note (other frontmatter and the body, including `[[wikilinks]]`) is
  preserved byte-for-byte. This is covered by `src/lib/vault.test.ts`.
- **Export is PNG** (2× scale, theme background). SVG export needs the unmaintained
  `cytoscape-svg` plugin; noted as a possible add.
- **Credential vault: standard WebCrypto primitives, no custom crypto.** The AD
  list is sealed with AES-256-GCM under a PBKDF2-HMAC-SHA256 key (600k iterations,
  per-blob random salt, fresh IV per write); the key is non-extractable and held
  in memory only. PBKDF2 is used over the stronger memory-hard Argon2id/scrypt
  deliberately: WebCrypto ships no native Argon2, and pulling in a WASM KDF to
  gain memory-hardness wasn't worth the bundle and supply-chain cost for a local
  tool whose realistic threat is an offline crack of a stolen `localStorage` blob
  — PBKDF2 at OWASP's iteration floor covers that. The iteration count is stored
  in each blob, so it can be raised later without breaking existing lists. Covered
  by `src/lib/credvault.test.ts`.
- **The Sliver overlay is read-only by construction.** The bridge exposes no
  implant-interaction endpoints, binds to loopback only, requires a bearer token,
  allowlists a single browser origin, and rejects non-loopback Host headers
  (a DNS-rebinding defense). See [`bridge/README.md`](bridge/README.md).

## Tests

Pure logic is covered by [Vitest](https://vitest.dev) (jsdom environment, since
`parseNmap` uses the browser `DOMParser`):

```bash
npm test
```

- `src/lib/parseNmap.test.ts` — nmap XML → model (ports, OS pick, hop ordering, down hosts)
- `src/lib/ad.test.ts` — DC detection, AD role, AD services, domain derivation
- `src/lib/topology.test.ts` — traceroute chaining / subnet grouping
- `src/types.test.ts` — subnet masking and OS-family classification
- `src/lib/vault.test.ts` — frontmatter parsing and surgical field updates
- `src/lib/credvault.test.ts` — credential encrypt/decrypt round-trip + wrong-passphrase rejection (Node env, for full WebCrypto)

## Roadmap

- **Scan diff / timeline** — the parser returns a stable per-IP model with
  `lastSeen`, so diffing two scans (new/gone hosts, port deltas) is a pure function
  away; the UI isn't built yet.
- **Minimap** — `cytoscape-navigator` would drop into `Graph.tsx`.
- **SVG export**, arrow-key selection walking, and a changelog appended to notes on
  scan diff.

## Notes & caveats

- Note previews render your own vault's markdown; output is sanitized with DOMPurify.
- Scan data is stored in `localStorage` (skipped if > ~4 MB) and never leaves the machine.
- IPv6 hosts parse fine but group under an `other` bucket in subnet view.
- Notes are matched to hosts by frontmatter `ip:` / `host:` first, then a filename
  that is itself the IP (`.obsidian/` and other dotfolders are skipped).
```
