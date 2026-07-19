import { useRef, useState } from 'react';
import { useStore } from '../store';
import { useFocusTrap } from '../lib/useFocusTrap';
import * as vault from '../lib/vault';

/**
 * Connect an Obsidian vault through the local `netmap-vault-bridge` helper — the
 * cross-browser path used when the File System Access API isn't available
 * (Firefox, Safari). Chromium browsers use the directory picker instead.
 */
export default function VaultBridgeModal() {
  const open = useStore((s) => s.vaultBridgeOpen);
  const setUi = useStore((s) => s.setUi);
  const savedUrl = useStore((s) => s.vaultBridgeUrl);
  const savedToken = useStore((s) => s.vaultBridgeToken);
  const setSetting = useStore((s) => s.setSetting);
  const setVault = useStore((s) => s.setVault);
  const showToast = useStore((s) => s.showToast);

  const [url, setUrl] = useState(savedUrl);
  const [token, setToken] = useState(savedToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, panelRef);

  if (!open) return null;

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const name = await vault.connectBridge(url, token);
      setSetting('vaultBridgeUrl', url.trim());
      setSetting('vaultBridgeToken', token.trim());
      const counts = await vault.rebuildIndex();
      setVault(name, counts, vault.statusByIp(), vault.bloodhoundIdByIp());
      showToast(`Vault "${name}" connected via bridge — ${counts.notes} notes, ${counts.matched} matched.`);
      setUi({ vaultBridgeOpen: false });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setUi({ vaultBridgeOpen: false })}>
      <div
        ref={panelRef}
        className="flex w-full max-w-lg flex-col rounded-none border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between border-b border-line p-5 pb-3">
          <div>
            <h2 className="font-display text-base font-semibold text-ink-1">Connect vault via bridge</h2>
            <p className="mt-0.5 text-[12px] text-ink-3">Cross-browser Obsidian access (Firefox / Safari) through a local helper.</p>
          </div>
          <button className="text-xs text-ink-3 hover:text-ink-1" onClick={() => setUi({ vaultBridgeOpen: false })}>
            Close
          </button>
        </div>

        <div className="space-y-4 p-5">
          <p className="text-xs leading-relaxed text-ink-2">
            Run the helper against your vault, then paste its URL and token below:
          </p>
          <pre className="overflow-x-auto rounded-none border border-line bg-well p-2 font-mono text-[12px] text-ink-2">
            cd bridge-vault{'\n'}go run . --vault /path/to/your/vault
          </pre>

          <label className="block">
            <span className="mb-1 block text-[12px] text-ink-3">Bridge URL</span>
            <input
              className="w-full rounded-none border border-line bg-well px-2.5 py-1.5 font-mono text-xs text-ink-1 focus:border-accent focus:outline-none"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://127.0.0.1:8899"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-ink-3">Bridge token</span>
            <input
              className="w-full rounded-none border border-line bg-well px-2.5 py-1.5 font-mono text-xs text-ink-1 focus:border-accent focus:outline-none"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="paste the token the bridge printed on startup"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && url.trim() && token.trim() && !busy) connect();
              }}
            />
          </label>

          {error && <p className="text-xs text-danger">{error}</p>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button className="btn" onClick={() => setUi({ vaultBridgeOpen: false })}>
              Cancel
            </button>
            <button className="btn-primary" onClick={connect} disabled={busy || !url.trim() || !token.trim()}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
