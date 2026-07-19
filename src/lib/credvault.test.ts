// @vitest-environment node
// Runs in the Node environment so the full WebCrypto (PBKDF2 + AES-GCM) is available.
import { describe, it, expect } from 'vitest';
import { encryptUsers, decryptUsers } from './credvault';
import type { UserCred } from '../types';

const USERS: UserCred[] = [
  { username: 'administrator', password: 'P@ssw0rd!', host: '10.0.0.5' },
  { username: 'svc-sql', password: 'Summer2026', host: 'dc01.zsm.local' },
];

describe('credvault crypto', () => {
  it('round-trips the list with the correct passphrase', async () => {
    const blob = await encryptUsers('correct horse battery', USERS);
    expect(blob.ct).not.toContain('P@ssw0rd'); // ciphertext does not leak the plaintext
    const out = await decryptUsers('correct horse battery', blob);
    expect(out).toEqual(USERS);
  });

  it('uses a fresh random salt/iv/ciphertext each time', async () => {
    const a = await encryptUsers('pw', USERS);
    const b = await encryptUsers('pw', USERS);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('rejects a wrong passphrase (GCM auth tag fails)', async () => {
    const blob = await encryptUsers('right', USERS);
    await expect(decryptUsers('wrong', blob)).rejects.toThrow();
  });
});
