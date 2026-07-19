import type { UserCred } from '../types';

/**
 * Passphrase protection for the AD credential list. This is mandatory: the list
 * is only ever stored encrypted — there is no plaintext code path.
 *
 * The user list is encrypted at rest with AES-GCM (256-bit); the key is derived
 * from a passphrase via PBKDF2-SHA256 and never stored — only a random salt + IV
 * + ciphertext are persisted. Unlocking re-derives the key and holds it in memory
 * for the session only, so a browser restart requires the passphrase again. There
 * is no recovery: forget the passphrase, lose the list.
 *
 * Scope: this protects the app's own `localStorage`. Exporting to the vault's
 * `AD Users.md` (or to .txt/.csv) is an explicit, plaintext export.
 */

const BLOB_KEY = 'netmap:users:enc'; // encrypted credential blob
const PLAIN_KEY = 'netmap:users'; // legacy/unprotected plaintext list (same key the store uses)
const ITERATIONS = 250_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncBlob {
  v: 1;
  iter: number;
  salt: string; // base64
  iv: string; // base64
  ct: string; // base64 (ciphertext + GCM tag)
}

// In-memory, non-extractable session key. Never persisted; cleared on lock/reload.
let sessionKey: CryptoKey | null = null;

// ---------- base64 <-> bytes ----------

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- primitives ----------

async function deriveKey(passphrase: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  );
}

async function encryptWithKey(key: CryptoKey, users: UserCred[], salt: Uint8Array, iter: number): Promise<EncBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(JSON.stringify(users));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { v: 1, iter, salt: b64encode(salt), iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
}

async function decryptWithKey(key: CryptoKey, blob: EncBlob): Promise<UserCred[]> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(blob.iv) }, key, b64decode(blob.ct));
  const parsed = JSON.parse(new TextDecoder().decode(plain));
  return Array.isArray(parsed) ? parsed : [];
}

// ---------- pure one-shot helpers (used by the session layer + tests) ----------

/** Encrypt a user list under a passphrase with a fresh random salt+IV. */
export async function encryptUsers(passphrase: string, users: UserCred[]): Promise<EncBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  return encryptWithKey(key, users, salt, ITERATIONS);
}

/** Decrypt a blob under a passphrase. Rejects if the passphrase is wrong (GCM tag fails). */
export async function decryptUsers(passphrase: string, blob: EncBlob): Promise<UserCred[]> {
  const key = await deriveKey(passphrase, b64decode(blob.salt), blob.iter);
  return decryptWithKey(key, blob);
}

// ---------- storage + session state ----------

export function isCryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

function readBlob(): EncBlob | null {
  try {
    const raw = localStorage.getItem(BLOB_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as EncBlob;
    return b && b.v === 1 && !!b.salt && !!b.iv && !!b.ct ? b : null;
  } catch {
    return null;
  }
}

/** True when an encrypted credential blob is present. */
export function isProtected(): boolean {
  return readBlob() != null;
}

/** True when a session key is held in memory (i.e. currently unlocked). */
export function isUnlocked(): boolean {
  return sessionKey != null;
}

/** Turn on protection: encrypt the current list, drop the plaintext copy, keep the key for the session. */
export async function enableProtection(passphrase: string, users: UserCred[]): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const blob = await encryptWithKey(key, users, salt, ITERATIONS);
  localStorage.setItem(BLOB_KEY, JSON.stringify(blob));
  localStorage.removeItem(PLAIN_KEY);
  sessionKey = key;
}

/** Unlock with a passphrase, returning the decrypted list. Throws on a wrong passphrase. */
export async function unlock(passphrase: string): Promise<UserCred[]> {
  const blob = readBlob();
  if (!blob) throw new Error('No protected credential store.');
  const key = await deriveKey(passphrase, b64decode(blob.salt), blob.iter);
  let users: UserCred[];
  try {
    users = await decryptWithKey(key, blob);
  } catch {
    throw new Error('Incorrect passphrase.');
  }
  sessionKey = key;
  return users;
}

/** Re-encrypt and persist the list (no-op unless protected and unlocked). Reuses the cached key. */
export async function saveEncrypted(users: UserCred[]): Promise<void> {
  const blob = readBlob();
  if (!blob || !sessionKey) return;
  const next = await encryptWithKey(sessionKey, users, b64decode(blob.salt), blob.iter);
  localStorage.setItem(BLOB_KEY, JSON.stringify(next));
}

/** Drop the in-memory key (the list must be re-unlocked to view again). */
export function lock(): void {
  sessionKey = null;
}
