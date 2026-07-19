import type { Host, UserCred } from '../types';
import { displayName, openPorts, subnetOf } from '../types';
import { adRole, adServices, isDomainController } from './ad';

/**
 * Obsidian vault access, isolated behind a small backend interface so the rest of
 * the app never touches the filesystem directly. Two backends implement it:
 *
 *  - FsaBackend — the File System Access API (`showDirectoryPicker`), Chromium only.
 *    The directory handle is persisted in IndexedDB so the vault is picked once.
 *  - BridgeBackend — HTTP to a local `netmap-vault-bridge` helper, so Firefox/Safari
 *    (which lack the File System Access API) can still read/write a real vault.
 *
 * Everything above the backend — the note index, matching, templating, frontmatter
 * surgery — is backend-agnostic and shared.
 */

export interface NoteRef {
  path: string; // vault-relative, e.g. "Network/Hosts/10.0.0.5.md"
  name: string; // basename without .md
  ip?: string; // from frontmatter (or filename fallback)
  status?: string; // frontmatter `status:`
  bhId?: string; // frontmatter `bloodhound_id:` / `objectid:` — BloodHound node object ID
}

/** Low-level vault I/O. Paths are vault-relative with forward slashes. */
interface VaultBackend {
  name(): string;
  list(): Promise<{ path: string; head: string }[]>; // every *.md file + its frontmatter head (~2 KB)
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  readBinary(path: string): Promise<Blob | null>;
  writeBinary(path: string, data: Blob): Promise<void>;
}

let active: VaultBackend | null = null;
let ipIndex = new Map<string, NoteRef>();
let nameIndex = new Map<string, NoteRef>();

// ---------- File System Access backend (Chromium) ----------

class FsaBackend implements VaultBackend {
  constructor(private root: FileSystemDirectoryHandle) {}
  name(): string {
    return this.root.name;
  }
  async list(): Promise<{ path: string; head: string }[]> {
    const out: { path: string; head: string }[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const entry of dir.values()) {
        if (entry.name.startsWith('.')) continue; // .obsidian, .trash, …
        if (entry.kind === 'directory') {
          await walk(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`);
        } else if (entry.name.toLowerCase().endsWith('.md')) {
          let head = '';
          try {
            head = (await (await (entry as FileSystemFileHandle).getFile()).text()).slice(0, 2000);
          } catch {
            /* unreadable — index by filename only */
          }
          out.push({ path: `${prefix}${entry.name}`, head });
        }
      }
    };
    await walk(this.root, '');
    return out;
  }
  private async fileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
    const parts = path.split('/').map((p) => p.trim()).filter(Boolean);
    const file = parts.pop();
    if (!file) throw new Error('empty path');
    let dir = this.root;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return dir.getFileHandle(file, { create });
  }
  async read(path: string): Promise<string> {
    return (await (await this.fileHandle(path)).getFile()).text();
  }
  async write(path: string, content: string): Promise<void> {
    const w = await (await this.fileHandle(path, true)).createWritable();
    await w.write(content);
    await w.close();
  }
  async readBinary(path: string): Promise<Blob | null> {
    try {
      return await (await this.fileHandle(path)).getFile();
    } catch {
      return null;
    }
  }
  async writeBinary(path: string, data: Blob): Promise<void> {
    const w = await (await this.fileHandle(path, true)).createWritable();
    await w.write(data);
    await w.close();
  }
}

// ---------- Bridge backend (any browser, via netmap-vault-bridge) ----------

class BridgeBackend implements VaultBackend {
  constructor(private base: string, private token: string, private vaultName: string) {}
  name(): string {
    return this.vaultName;
  }
  private q(path: string): string {
    return `${this.base}/file?path=${encodeURIComponent(path)}`;
  }
  private blobUrl(path: string): string {
    return `${this.base}/blob?path=${encodeURIComponent(path)}`;
  }
  private auth(): HeadersInit {
    return { Authorization: `Bearer ${this.token}` };
  }
  async list(): Promise<{ path: string; head: string }[]> {
    const res = await fetch(`${this.base}/notes`, { headers: this.auth() });
    if (!res.ok) throw new Error(`vault bridge /notes → ${res.status}`);
    const json = (await res.json()) as { notes?: { path: string; head: string }[] };
    return json.notes ?? [];
  }
  async read(path: string): Promise<string> {
    const res = await fetch(this.q(path), { headers: this.auth() });
    if (!res.ok) throw new Error(`vault bridge read ${path} → ${res.status}`);
    return res.text();
  }
  async write(path: string, content: string): Promise<void> {
    const res = await fetch(this.q(path), { method: 'PUT', headers: this.auth(), body: content });
    if (!res.ok) throw new Error(`vault bridge write ${path} → ${res.status}`);
  }
  async readBinary(path: string): Promise<Blob | null> {
    const res = await fetch(this.blobUrl(path), { headers: this.auth() });
    return res.ok ? res.blob() : null;
  }
  async writeBinary(path: string, data: Blob): Promise<void> {
    const res = await fetch(this.blobUrl(path), { method: 'PUT', headers: this.auth(), body: data });
    if (!res.ok) throw new Error(`vault bridge write ${path} → ${res.status}`);
  }
}

// ---------- IndexedDB persistence of the directory handle (FSA only) ----------

const DB = 'netmap-vault';
const STORE = 'handles';

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

// ---------- connect / restore ----------

/** True when this browser has the File System Access API (Chromium). */
export function isFsaSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function pickVault(): Promise<string> {
  const handle = await window.showDirectoryPicker({ id: 'obsidian-vault', mode: 'readwrite' });
  await idbSet('vault', handle);
  active = new FsaBackend(handle);
  await rebuildIndex();
  return handle.name;
}

/** Try to restore the previously picked (FSA) vault. Returns the vault name, or null. */
export async function restoreVault(interactive: boolean): Promise<string | null> {
  if (!isFsaSupported()) return null;
  const handle = await idbGet<FileSystemDirectoryHandle>('vault').catch(() => undefined);
  if (!handle) return null;
  const q = (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
  if (q !== 'granted') {
    if (!interactive) return null;
    const r = (await handle.requestPermission?.({ mode: 'readwrite' })) ?? 'denied';
    if (r !== 'granted') return null;
  }
  active = new FsaBackend(handle);
  await rebuildIndex();
  return handle.name;
}

function normalizeBridgeBase(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u;
}

/** Connect to a running netmap-vault-bridge; returns the vault name. Throws on failure. */
export async function connectBridge(url: string, token: string): Promise<string> {
  const base = normalizeBridgeBase(url);
  let res: Response;
  try {
    res = await fetch(`${base}/vault`, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new Error('Could not reach the vault bridge — is it running?');
  }
  if (res.status === 401) throw new Error('Vault bridge rejected the token.');
  if (!res.ok) throw new Error(`Vault bridge error (${res.status}).`);
  const name = ((await res.json()) as { name?: string }).name || 'vault';
  active = new BridgeBackend(base, token, name);
  await rebuildIndex();
  return name;
}

/** Silently reconnect a previously-configured bridge (used on load). Returns name or null. */
export async function restoreBridge(url: string, token: string): Promise<string | null> {
  if (!url || !token) return null;
  return connectBridge(url, token).catch(() => null);
}

export function vaultName(): string | null {
  return active?.name() ?? null;
}

// ---------- index ----------

const IP_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Scan the vault via the active backend and build ip→note and name→note indexes.
 * Matching priority per note: frontmatter `ip:`/`host:` first, then a filename that
 * is itself an IP. Dotfolders (.obsidian/…) are skipped by the backend's list().
 */
export async function rebuildIndex(): Promise<{ notes: number; matched: number }> {
  ipIndex = new Map();
  nameIndex = new Map();
  if (!active) return { notes: 0, matched: 0 };
  for (const { path, head } of await active.list()) {
    const name = (path.split('/').pop() ?? path).replace(/\.md$/i, '');
    const fm = parseFrontmatter(head);
    const ref: NoteRef = {
      path,
      name,
      ip: fm.ip ?? fm.host ?? (IP_RE.test(name) ? name : undefined),
      status: fm.status,
      bhId: fm.bloodhound_id ?? fm.objectid,
    };
    nameIndex.set(name.toLowerCase(), ref);
    if (ref.ip && !ipIndex.has(ref.ip)) ipIndex.set(ref.ip, ref);
  }
  return { notes: nameIndex.size, matched: ipIndex.size };
}

export function noteForIp(ip: string): NoteRef | undefined {
  return ipIndex.get(ip);
}

export function noteByName(name: string): NoteRef | undefined {
  return nameIndex.get(name.toLowerCase());
}

export function statusByIp(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ip, ref] of ipIndex) if (ref.status) out[ip] = ref.status;
  return out;
}

export function bloodhoundIdByIp(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ip, ref] of ipIndex) if (ref.bhId) out[ip] = ref.bhId;
  return out;
}

// ---------- read / write / create ----------

export async function readNote(ref: NoteRef): Promise<string> {
  if (!active) throw new Error('No vault connected.');
  return active.read(ref.path);
}

export async function writeNote(ref: NoteRef, content: string): Promise<void> {
  if (!active) throw new Error('No vault connected.');
  await active.write(ref.path, content);
  const fm = parseFrontmatter(content.slice(0, 2000));
  ref.status = fm.status;
  ref.bhId = fm.bloodhound_id ?? fm.objectid;
  const ip = fm.ip ?? fm.host;
  if (ip && !ipIndex.has(ip)) {
    ref.ip = ip;
    ipIndex.set(ip, ref);
  }
}

/** Create a host note from the template inside `folder` (created if missing). */
export async function createNote(host: Host, folder: string, scanDate?: string): Promise<NoteRef> {
  if (!active) throw new Error('No vault connected.');
  const parts = folder.split('/').map((p) => p.trim()).filter(Boolean);
  const fileName = `${host.ip}.md`;
  const path = [...parts, fileName].join('/');
  await active.write(path, renderTemplate(host, scanDate));

  const ref: NoteRef = { path, name: host.ip, ip: host.ip, status: 'unreviewed' };
  ipIndex.set(host.ip, ref);
  nameIndex.set(host.ip.toLowerCase(), ref);
  return ref;
}

export function renderTemplate(host: Host, scanDate?: string): string {
  const open = openPorts(host);
  const table = open.length
    ? [
        '| Port | Proto | Service | Product | Version |',
        '| ---- | ----- | ------- | ------- | ------- |',
        ...open.map(
          (p) => `| ${p.number} | ${p.protocol} | ${p.service ?? ''} | ${p.product ?? ''} | ${p.version ?? ''} |`,
        ),
      ].join('\n')
    : '_No open ports observed._';

  const subnetTag = subnetOf(host.ip, 24).replace('/', '-');
  const role = adRole(host);
  const services = adServices(host);
  const adTag = role === 'Domain Controller' ? ', ad/domain-controller' : role === 'AD Member' ? ', ad/member' : '';
  const adSection = services.length
    ? `## Active Directory
- Role: ${role}${isDomainController(host) ? ' **(Domain Controller)**' : ''}
- Services: ${services.join(', ')}

`
    : '';

  return `---
ip: ${host.ip}
hostnames: [${host.hostnames.map(yamlScalar).join(', ')}]
os: ${yamlScalar(host.os ?? '')}
mac: ${yamlScalar(host.mac ?? '')}
ad_role: ${role}
bloodhound_id:
first_seen: ${scanDate ?? new Date().toISOString().slice(0, 10)}
tags: [host, network/${subnetTag}${adTag}]
status: unreviewed
---

# ${displayName(host)}

## Open ports
${table}

${adSection}## Notes

`;
}

// ---------- attachments (pasted images) ----------

/** Write a binary blob into the vault's top-level `attachments/` folder. Returns the vault-relative path. */
export async function saveAttachment(data: Blob, ext: string): Promise<string> {
  if (!active) throw new Error('No vault connected.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = `attachments/pasted-${stamp}.${ext}`;
  await active.writeBinary(path, data);
  return path;
}

/** Resolve a vault-relative path to its file blob, or null if it can't be found. */
export async function readBinary(path: string): Promise<Blob | null> {
  if (!active) return null;
  return active.readBinary(path);
}

// ---------- AD user/credential list, stored in the vault ----------

export const CREDS_FILE = 'AD Users.md';

// A raw `|` or newline would break the markdown table, so encode pipes as an
// HTML entity (unambiguous, still readable in Obsidian) and flatten newlines.
const escCell = (s: string) => (s ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '&#124;');
const unescCell = (s: string) => s.trim().replace(/&#124;/g, '|');

function renderCreds(users: UserCred[]): string {
  const rows = users.map((u) => `| ${escCell(u.username)} | ${escCell(u.password)} | ${escCell(u.host ?? '')} |`);
  return `---
tags: [netmap, credentials]
---

# AD Users

Maintained by netmap — usernames, plaintext passwords, and the host each credential targets.

| Username | Password | Host |
| --- | --- | --- |
${rows.join('\n')}
`;
}

function parseCreds(text: string): UserCred[] {
  const out: UserCred[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(unescCell);
    if (cells.length < 2) continue;
    const [username, password, host] = cells;
    if (!username || /^-+$/.test(username) || username.toLowerCase() === 'username') continue;
    out.push({ username, password: password ?? '', host: host || undefined });
  }
  return out;
}

/** Write the credential list to `AD Users.md` at the vault root. */
export async function saveUserList(users: UserCred[]): Promise<string> {
  if (!active) throw new Error('No vault connected.');
  await active.write(CREDS_FILE, renderCreds(users));
  return CREDS_FILE;
}

/** Read the credential list from the vault, or null if the file doesn't exist. */
export async function loadUserList(): Promise<UserCred[] | null> {
  if (!active) throw new Error('No vault connected.');
  try {
    return parseCreds(await active.read(CREDS_FILE));
  } catch {
    return null;
  }
}

// ---------- frontmatter helpers ----------

export function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Quote a value as a YAML double-quoted scalar when it contains characters that
 * would break a simple `key: value` line (a colon, brackets, quotes, a leading
 * `-`/space, a trailing space, …). Safe plain values pass through unchanged; an
 * empty string stays empty (an unset field). parseFrontmatter strips the quotes.
 */
export function yamlScalar(v: string): string {
  if (v === '') return '';
  const risky = /[:#[\]{}",'&*!?|>@`%]|^[-\s]|\s$/.test(v);
  return risky ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v;
}

/** Set or insert a single scalar frontmatter field, preserving everything else byte-for-byte. */
export function setFrontmatterField(content: string, key: string, value: string): string {
  const v = yamlScalar(value);
  const m = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!m) return `---\n${key}: ${v}\n---\n\n${content}`;
  const body = m[2];
  const lineRe = new RegExp(`^${key}:.*$`, 'm');
  // Use a replacer function so `$` in the value isn't treated as a special group ref.
  const newBody = lineRe.test(body) ? body.replace(lineRe, () => `${key}: ${v}`) : `${body}\n${key}: ${v}`;
  return content.slice(0, m.index!) + m[1] + newBody + m[3] + content.slice(m.index! + m[0].length);
}
