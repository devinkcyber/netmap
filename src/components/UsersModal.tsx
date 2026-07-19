import { useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import type { UserCred } from '../types';
import * as vault from '../lib/vault';
import { isCryptoAvailable } from '../lib/credvault';
import { useFocusTrap } from '../lib/useFocusTrap';

/**
 * Parse a user list into rows. Each non-empty, non-comment line is a username;
 * an optional password may follow after the first `:`, `,` or tab separator
 * (so `user.txt` lists and `user:pass` files both work). Existing usernames are
 * kept as-is (case-insensitive) so re-importing never clobbers assigned passwords.
 */
function parseUserList(text: string, existing: UserCred[]): { users: UserCred[]; added: number } {
  const seen = new Set(existing.map((u) => u.username.toLowerCase()));
  const out = [...existing];
  let added = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.search(/[:,\t]/);
    const username = (sep >= 0 ? line.slice(0, sep) : line).trim();
    const password = sep >= 0 ? line.slice(sep + 1).trim() : '';
    if (!username) continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ username, password });
    added++;
  }
  return { users: out, added };
}

function download(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

const inputCls =
  'rounded-none border border-line bg-well px-2.5 py-1.5 font-mono text-xs text-ink-1 placeholder:text-ink-3 focus:border-accent focus:outline-none';

export default function UsersModal() {
  const open = useStore((s) => s.usersOpen);
  const users = useStore((s) => s.users);
  const setUsers = useStore((s) => s.setUsers);
  const setUi = useStore((s) => s.setUi);
  const showToast = useStore((s) => s.showToast);
  const vaultName = useStore((s) => s.vaultName);
  const credProtected = useStore((s) => s.credProtected);
  const credLocked = useStore((s) => s.credLocked);
  const enableCredProtection = useStore((s) => s.enableCredProtection);
  const unlockCreds = useStore((s) => s.unlockCreds);
  const lockCreds = useStore((s) => s.lockCreds);

  const [reveal, setReveal] = useState(false);
  const [filter, setFilter] = useState('');
  const [paste, setPaste] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, panelRef);

  // Passphrase state (used by both the set-up and unlock views).
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [passErr, setPassErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cryptoOk = isCryptoAvailable();

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    // Keep original indexes so edits map back to the real array.
    return users
      .map((u, i) => ({ u, i }))
      .filter(({ u }) => !q || u.username.toLowerCase().includes(q) || (u.host ?? '').toLowerCase().includes(q));
  }, [users, filter]);

  if (!open) return null;

  const withPassword = users.filter((u) => u.password).length;

  function ingest(text: string) {
    const { users: next, added } = parseUserList(text, users);
    setUsers(next);
    showToast(added ? `Imported ${added} user${added === 1 ? '' : 's'}.` : 'No new usernames found in that list.');
  }

  async function fromFile(file: File | undefined) {
    if (!file) return;
    ingest(await file.text());
  }

  function updateUser(index: number, patch: Partial<UserCred>) {
    setUsers(users.map((u, i) => (i === index ? { ...u, ...patch } : u)));
  }
  function removeUser(index: number) {
    setUsers(users.filter((_, i) => i !== index));
  }
  function addUser() {
    setUsers([...users, { username: '', password: '' }]);
  }

  function exportTxt() {
    download('user.txt', users.map((u) => u.username).join('\n') + '\n');
  }
  function exportCsv() {
    const rows = ['username,password,host', ...users.map((u) => `${csvCell(u.username)},${csvCell(u.password)},${csvCell(u.host ?? '')}`)];
    download('users.csv', rows.join('\n') + '\n');
  }

  async function saveToVault() {
    if (!window.confirm(`This writes the credentials as plaintext to ${vault.CREDS_FILE} in your vault. Continue?`)) return;
    try {
      const f = await vault.saveUserList(users);
      showToast(`Saved ${users.length} user${users.length === 1 ? '' : 's'} to ${f} in the vault.`);
    } catch (e) {
      showToast(`Could not save to vault: ${(e as Error).message}`);
    }
  }

  async function loadFromVault() {
    try {
      const loaded = await vault.loadUserList();
      if (!loaded) {
        showToast(`No ${vault.CREDS_FILE} found in the vault.`);
        return;
      }
      if (users.length && !window.confirm(`Replace the current ${users.length}-user list with ${loaded.length} from the vault?`)) return;
      setUsers(loaded);
      showToast(`Loaded ${loaded.length} user${loaded.length === 1 ? '' : 's'} from the vault.`);
    } catch (e) {
      showToast(`Could not load from vault: ${(e as Error).message}`);
    }
  }

  // ---- passphrase set-up / unlock ----
  async function doSetup() {
    if (pass.length < 6) {
      setPassErr('Use a passphrase of at least 6 characters.');
      return;
    }
    if (pass !== pass2) {
      setPassErr('Passphrases do not match.');
      return;
    }
    setBusy(true);
    setPassErr(null);
    try {
      await enableCredProtection(pass);
      setPass('');
      setPass2('');
      showToast('Passphrase set — credentials are now encrypted.');
    } catch (e) {
      setPassErr(`Could not set the passphrase: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function doUnlock() {
    setBusy(true);
    setPassErr(null);
    try {
      await unlockCreds(pass);
      setPass('');
      showToast('Credentials unlocked.');
    } catch (e) {
      setPassErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function doLock() {
    lockCreds();
    showToast('Credentials locked.');
  }

  const subtitle = !credProtected
    ? '🔒 Set a passphrase to begin — credentials are always stored encrypted'
    : credLocked
      ? '🔒 Locked — enter your passphrase to view the credentials'
      : `${users.length} user${users.length === 1 ? '' : 's'} · ${withPassword} with a password · 🔓 encrypted in this browser`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setUi({ usersOpen: false })}>
      <div ref={panelRef} className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-none border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between border-b border-line p-5 pb-3">
          <div>
            <h2 className="font-display text-base font-semibold text-ink-1">AD users &amp; credentials</h2>
            <p className="mt-0.5 text-[12px] text-ink-3">{subtitle}</p>
          </div>
          <button className="text-xs text-ink-3 hover:text-ink-1" onClick={() => setUi({ usersOpen: false })}>
            Close
          </button>
        </div>

        {!credProtected ? (
          /* ---- First run: set a passphrase (mandatory) ---- */
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10">
            <div className="text-4xl" aria-hidden>
              🔒
            </div>
            {cryptoOk ? (
              <>
                <p className="max-w-sm text-center text-xs text-ink-2">
                  Credentials are stored <span className="text-ink-1">encrypted</span> (AES-GCM). Choose a passphrase to unlock
                  them each session. <span className="text-warn">There is no recovery if you forget it.</span>
                </p>
                <input
                  type="password"
                  autoFocus
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  placeholder="Passphrase (min 6 chars)"
                  className={`w-64 text-center ${inputCls}`}
                />
                <input
                  type="password"
                  value={pass2}
                  onChange={(e) => setPass2(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void doSetup();
                  }}
                  placeholder="Confirm passphrase"
                  className={`w-64 text-center ${inputCls}`}
                />
                {passErr && <p className="text-[12px] text-danger">{passErr}</p>}
                <button className="btn-primary" disabled={busy || !pass} onClick={() => void doSetup()}>
                  {busy ? 'Encrypting…' : 'Set passphrase'}
                </button>
              </>
            ) : (
              <p className="max-w-sm text-center text-xs text-danger">
                Credential encryption needs the WebCrypto API, which requires a secure context. Open netmap over{' '}
                <span className="font-mono">http://localhost</span> or HTTPS to use the credentials feature.
              </p>
            )}
          </div>
        ) : credLocked ? (
          /* ---- Locked: unlock prompt ---- */
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10">
            <div className="text-4xl" aria-hidden>
              🔒
            </div>
            <p className="max-w-xs text-center text-xs text-ink-2">Enter the passphrase to unlock the credential list for this session.</p>
            <input
              type="password"
              autoFocus
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && pass) void doUnlock();
              }}
              placeholder="Passphrase"
              className={`w-64 text-center ${inputCls}`}
            />
            {passErr && <p className="text-[12px] text-danger">{passErr}</p>}
            <button className="btn-primary" disabled={busy || !pass} onClick={() => void doUnlock()}>
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
          </div>
        ) : (
          /* ---- Unlocked: the editor ---- */
          <>
            {/* Import row */}
            <div className="flex flex-wrap items-end gap-2 border-b border-line px-5 py-3">
              <button className="btn" onClick={() => fileRef.current?.click()} title="Load a user.txt (or user:pass) file">
                Import user.txt
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.csv,.lst,text/plain"
                className="hidden"
                onChange={(e) => {
                  void fromFile(e.target.files?.[0] ?? undefined);
                  e.target.value = '';
                }}
              />
              <div className="flex flex-1 items-end gap-2">
                <textarea
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  rows={1}
                  spellCheck={false}
                  placeholder="…or paste usernames, one per line"
                  className="min-h-[34px] flex-1 resize-y rounded-none border border-line bg-well px-2.5 py-1.5 font-mono text-[12px] text-ink-1 placeholder:text-ink-3 focus:border-accent focus:outline-none"
                />
                <button
                  className="btn-primary"
                  disabled={!paste.trim()}
                  onClick={() => {
                    ingest(paste);
                    setPaste('');
                  }}
                >
                  Add
                </button>
              </div>
            </div>

            {/* Toolbar */}
            <div className="flex items-center gap-2 px-5 py-2 text-xs">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter…"
                className="w-40 rounded-none border border-line bg-well px-2 py-1 font-mono text-[12px] text-ink-1 placeholder:text-ink-3 focus:border-accent focus:outline-none"
              />
              <label className="flex items-center gap-1.5 text-ink-2">
                <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} className="accent-[#4fd88a]" />
                Show passwords
              </label>
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                <button className="btn" onClick={addUser}>
                  Add row
                </button>
                <button className="btn" onClick={doLock} title="Lock now — clears the in-memory key">
                  🔒 Lock
                </button>
                {vaultName && (
                  <>
                    <button className="btn" onClick={saveToVault} disabled={users.length === 0} title={`Write the list to ${vault.CREDS_FILE} in the vault`}>
                      Save to vault
                    </button>
                    <button className="btn" onClick={loadFromVault} title={`Read ${vault.CREDS_FILE} from the vault`}>
                      Load from vault
                    </button>
                  </>
                )}
                <button className="btn" onClick={exportTxt} disabled={users.length === 0} title="Download usernames as user.txt">
                  Export .txt
                </button>
                <button className="btn" onClick={exportCsv} disabled={users.length === 0} title="Download username,password,host as CSV">
                  Export .csv
                </button>
              </div>
            </div>

            {/* Table */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
              {users.length === 0 ? (
                <p className="py-10 text-center text-xs text-ink-3">
                  No users yet. Import your <span className="font-mono">user.txt</span> or paste a list above.
                </p>
              ) : (
                <table className="w-full border-collapse text-xs">
                  <thead className="sticky top-0 bg-panel">
                    <tr className="border-b border-line text-left text-[12px] text-ink-3">
                      <th className="py-1.5 pr-2 font-medium">Username</th>
                      <th className="py-1.5 pr-2 font-medium">Password</th>
                      <th className="py-1.5 pr-2 font-medium" title="IP or hostname this credential is valid on — ties it to a node on the map">
                        Host
                      </th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(({ u, i }) => (
                      <tr key={i} className="border-b border-line/50">
                        <td className="py-1 pr-2">
                          <input
                            value={u.username}
                            spellCheck={false}
                            onChange={(e) => updateUser(i, { username: e.target.value })}
                            className="w-full rounded-none border border-transparent bg-transparent px-1.5 py-1 font-mono text-ink-1 hover:border-line focus:border-accent focus:bg-well focus:outline-none"
                          />
                        </td>
                        <td className="py-1 pr-2">
                          <input
                            type={reveal ? 'text' : 'password'}
                            value={u.password}
                            spellCheck={false}
                            autoComplete="off"
                            placeholder="—"
                            onChange={(e) => updateUser(i, { password: e.target.value })}
                            className="w-full rounded-none border border-transparent bg-transparent px-1.5 py-1 font-mono text-ink-1 placeholder:text-ink-3 hover:border-line focus:border-accent focus:bg-well focus:outline-none"
                          />
                        </td>
                        <td className="py-1 pr-2">
                          <input
                            value={u.host ?? ''}
                            spellCheck={false}
                            placeholder="—"
                            onChange={(e) => updateUser(i, { host: e.target.value || undefined })}
                            className="w-full rounded-none border border-transparent bg-transparent px-1.5 py-1 font-mono text-ink-1 placeholder:text-ink-3 hover:border-line focus:border-accent focus:bg-well focus:outline-none"
                          />
                        </td>
                        <td className="py-1 text-right">
                          <button
                            className="rounded-none px-1.5 text-ink-3 hover:bg-raise hover:text-danger"
                            title={`Remove ${u.username || 'row'}`}
                            onClick={() => removeUser(i)}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
