# netmap

[**▶ Live demo**](https://devinkcyber.github.io/netmap/) — runs entirely in your browser on a bundled sample scan; no install, no backend.

[![CI](https://github.com/devinkcyber/netmap/actions/workflows/ci.yml/badge.svg)](https://github.com/devinkcyber/netmap/actions/workflows/ci.yml)

**Turn an nmap scan into an interactive network map, with your Obsidian notes attached to every host.**

Import an `nmap -oX` XML scan and netmap renders your network as an interactive
graph. Click any host to read and edit its Obsidian note in place — the note is
the real `.md` file in your vault, read and written through the browser's File
System Access API. No backend, no database, no Obsidian plugin; everything runs
client-side and offline.

Built for pentesters and red-teamers who live in nmap + Obsidian and want their
recon to be visual and their notes one click away.

![netmap — a traceroute topology of a demo network: subnet-colored hosts, gold-ringed domain controllers, router hops, and a Ligolo pivot path](docs/screenshot.png)

## Quick start

```bash
git clone https://github.com/devinkcyber/netmap.git
cd netmap
npm install
npm run dev          # → http://localhost:5173
```

Then click **Load sample scan** in the import dialog — no nmap required — to see
the whole thing working against the bundled demo network. To use your own data,
import a real scan (below) and connect your Obsidian vault.

> **Vault editing on Chromium is zero-setup.** The graph works in any modern browser,
> but reading and writing vault notes normally uses the File System Access API
> (`showDirectoryPicker`), which only Chromium ships (Chrome, Edge, Brave, Arc). On
> **Firefox / Safari**, run the tiny local `bridge-vault/` helper and connect through
> it instead — everything else is identical. See [`bridge-vault/README.md`](bridge-vault/README.md).

## Generating a scan

```bash
sudo nmap -sV -O --traceroute -oX scan.xml <targets>
```

| flag | what it gives netmap | required? |
| --- | --- | --- |
| `-oX scan.xml` | the XML netmap parses | **yes** |
| `--traceroute` | real hop paths → genuine topology edges | recommended |
| `-O` | OS detection (drives host colors), needs root | optional |
| `-sV` | service/version detail in the ports table | optional |

Everything optional degrades gracefully: no traceroute falls back to subnet
grouping; without `-O`/`-sV`, hosts are colored "Unknown" and the ports table
shows fewer columns.

## Features

- **Interactive topology** — force / concentric / tree layouts, fit, reset,
  arrow-key navigation, shift-drag to move a whole subnet, search (`/`), PNG
  export, and dark & light themes.
- **Two topology models** — *traceroute* chains real hop paths into a tree (with
  router nodes for unscanned hops); *subnets* groups hosts under synthetic subnet
  nodes at a configurable mask.
- **Obsidian notes in place** — click a host to read/edit its real vault `.md`.
  Debounced autosave + `Ctrl/Cmd+S`, frontmatter and `[[wikilinks]]` preserved
  byte-for-byte, paste-to-embed images, one-click note scaffolding from a
  template, and bulk "notes for all hosts".
- **Active Directory awareness** — domain-controller detection from AD service
  fingerprints (gold-ringed hexagons), AD role + exposed AD services per host,
  and domain-based coloring that separates a child domain from its parent.
  Heuristics live in [`src/lib/ad.ts`](src/lib/ad.ts).
- **Recon workflow** — per-host review status (unreviewed / reviewed / owned)
  shown as node rings and filterable; rich filters (subnet, OS family,
  port/service, note status); a live color-by legend.
- **Credentials** — import `user.txt` / `user:pass` lists, assign passwords and a
  target host, export to txt/csv; matched credentials surface on the host and get
  a 🔑 on the graph. The list is **encrypted at rest behind a passphrase** (see
  Security below).
- **BloodHound CE deep-links** — jump from a host to its node in BloodHound by
  object ID (SID), with a name-based Cypher fallback.
- **Manual overrides & persistence** — right-click a host to flag a Ligolo pivot
  (📡) or force domain-controller status; node positions, the last scan, the vault
  handle, and all settings survive reloads.

## Keyboard & mouse

Press **`?`** in the app (or the `?` button in the toolbar) for the full list. The essentials:

| input | action |
| --- | --- |
| `/` | focus search — jump to an IP, host, or service |
| `f` | fit the whole graph to the screen |
| `↑ ↓ ← →` | move the selection to the next node |
| `Shift` + drag | move a group — a subnet's hosts, a router's subtree, or the scanner's first hops |
| right-click a host | actions: mark DC, open in BloodHound, Ligolo pivot & unlocked subnets |
| `e` · `Ctrl`/`Cmd`+`S` | toggle note edit/preview · save the note |
| `Esc` | close a dialog / cancel linking |

## Optional: live Sliver C2 overlay

netmap can overlay live [Sliver](https://github.com/BishopFox/sliver) implant
state onto the map — sessions and beacons light up the hosts they run on. This is
**entirely optional**; netmap is fully usable without it, and cloning this repo
does not connect to anything.

Because a browser can't speak Sliver's mTLS gRPC, a small **read-only,
loopback-only** Go helper (`bridge/`) holds the operator credentials and exposes a
JSON/WebSocket API that netmap consumes. It has **no implant-interaction
endpoints** — the read-only scope is enforced by their absence. Setup and the full
security model are in [`bridge/README.md`](bridge/README.md).

## Building & hosting

```bash
npm run build        # → dist/ (a static bundle, deployable anywhere)
npm run preview      # serve the production build locally
npm test             # run the unit tests
```

`dist/` is fully static — host it on GitHub Pages, Netlify, or any static host for
a shareable demo. (The graph and sample scan work in every browser; vault editing
is zero-setup on Chromium, or via the `bridge-vault/` helper on Firefox/Safari.)

## How it works

See **[DESIGN.md](DESIGN.md)** for the architecture, the reasoning behind the main
technical choices, the test layout, and the roadmap.

## Security & privacy

netmap is built to run on **your own analysis workstation**. Everything is
client-side and offline: scan data lives in `localStorage` (skipped if very large)
and never leaves the machine, and note previews are sanitized with DOMPurify.

Credentials you enter (AD passwords) are **always encrypted at rest behind a
passphrase**. You set one the first time you open the Users panel and unlock the
list once per session; encryption is AES-GCM with a key derived via PBKDF2-SHA256
and held in memory only (a browser restart re-locks it). There is no plaintext
storage path. Saving the list to `AD Users.md` in your vault, or exporting to
.txt/.csv, is an explicit **plaintext** export — treat the browser profile and the
vault as sensitive engagement data and protect them accordingly.

> Encryption uses the WebCrypto API, which requires a secure context —
> `http://localhost` (the dev/preview server) or HTTPS. There is **no passphrase
> recovery**: if you forget it, the encrypted list can't be read.

## License

[Apache License 2.0](LICENSE)
