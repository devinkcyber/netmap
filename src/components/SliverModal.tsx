import { useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { connectSliver, disconnectSliver, loadSampleImplants, type SliverImplant, type SliverStatus } from '../lib/sliver';
import { displayName, type Host } from '../types';
import { useFocusTrap } from '../lib/useFocusTrap';
import BeaconTimer from './BeaconTimer';

const STATUS_LABEL: Record<SliverStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Reconnecting…',
};

function statusDotClass(status: SliverStatus): string {
  return status === 'connected' ? 'bg-ok' : status === 'connecting' ? 'bg-warn' : status === 'error' ? 'bg-danger' : 'bg-ink-3';
}

function since(unixSec: number): string {
  if (!unixSec) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function SliverModal() {
  const open = useStore((s) => s.sliverOpen);
  const setUi = useStore((s) => s.setUi);
  const status = useStore((s) => s.sliverStatus);
  const implants = useStore((s) => s.sliverImplants);
  const savedUrl = useStore((s) => s.sliverUrl);
  const savedToken = useStore((s) => s.sliverToken);
  const hosts = useStore((s) => s.hosts);
  const matchOverride = useStore((s) => s.sliverMatchOverride);
  const setSliverMatch = useStore((s) => s.setSliverMatch);
  const autoOwned = useStore((s) => s.sliverAutoOwned);
  const setSetting = useStore((s) => s.setSetting);
  const setSliver = useStore((s) => s.setSliver);

  const [url, setUrl] = useState(savedUrl);
  const [token, setToken] = useState(savedToken);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, panelRef);

  const sessions = useMemo(() => implants.filter((i) => i.kind === 'session'), [implants]);
  const beacons = useMemo(() => implants.filter((i) => i.kind === 'beacon'), [implants]);

  if (!open) return null;

  const connected = status === 'connected' || status === 'connecting' || status === 'error';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setUi({ sliverOpen: false })}>
      <div ref={panelRef} className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-none border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between border-b border-line p-5 pb-3">
          <div>
            <h2 className="font-display text-base font-semibold text-ink-1">Sliver C2</h2>
            <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-3">
              <span className={`inline-block h-2 w-2 rounded-full ${statusDotClass(status)}`} />
              {STATUS_LABEL[status]}
              {status === 'connected' && (
                <span>
                  {' '}
                  · {sessions.length} session{sessions.length === 1 ? '' : 's'} · {beacons.length} beacon{beacons.length === 1 ? '' : 's'}
                </span>
              )}
            </p>
          </div>
          <button className="text-xs text-ink-3 hover:text-ink-1" onClick={() => setUi({ sliverOpen: false })}>
            Close
          </button>
        </div>

        {/* Connection form */}
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 border-b border-line px-5 py-4">
          <label className="text-xs text-ink-2">Bridge URL</label>
          <input
            value={url}
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://127.0.0.1:8888"
            className="w-full rounded-none border border-line bg-well px-2.5 py-1.5 font-mono text-xs text-ink-1 placeholder:text-ink-3 focus:border-accent focus:outline-none"
          />
          <label className="text-xs text-ink-2">Token</label>
          <div className="flex gap-2">
            <input
              value={token}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setToken(e.target.value)}
              placeholder="bridge token (printed on bridge startup)"
              className="w-full rounded-none border border-line bg-well px-2.5 py-1.5 font-mono text-xs text-ink-1 placeholder:text-ink-3 focus:border-accent focus:outline-none"
            />
            {connected ? (
              <button className="btn shrink-0" onClick={() => disconnectSliver()}>
                Disconnect
              </button>
            ) : (
              <button className="btn-primary shrink-0" disabled={!url.trim() || !token.trim()} onClick={() => connectSliver(url.trim(), token.trim())}>
                Connect
              </button>
            )}
          </div>
          <p className="col-span-2 text-[12px] leading-relaxed text-ink-3">
            Start the bridge (<span className="font-mono">bridge/</span>) and paste its token here. netmap connects to the read-only{' '}
            <span className="font-mono">/events</span> stream over WebSocket.
          </p>
        </div>

        {/* Options */}
        <label className="flex items-center gap-1.5 border-b border-line px-5 py-2 text-xs text-ink-2">
          <input type="checkbox" checked={autoOwned} onChange={(e) => setSetting('sliverAutoOwned', e.target.checked)} className="accent-[#4fd88a]" />
          Mark hosts with a live session as <span className="font-medium text-ink-1">owned</span> on the map (visual only)
        </label>

        {/* Demo data — populate a session + beacon with no Sliver server, for testing the overlay */}
        {!connected && (
          <div className="flex items-center gap-2 border-b border-line px-5 py-2 text-xs">
            {implants.length === 0 ? (
              <button className="btn shrink-0" onClick={() => loadSampleImplants()}>
                Load demo implants
              </button>
            ) : (
              <button className="btn shrink-0" onClick={() => setSliver({ sliverImplants: [] })}>
                Clear demo implants
              </button>
            )}
            <span className="text-[12px] leading-tight text-ink-3">
              No Sliver server needed — puts a demo beacon + session on scanned hosts so you can test the C2 overlay.
            </span>
          </div>
        )}

        {/* Implant list */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-3">
          {implants.length === 0 ? (
            <p className="py-8 text-center text-xs text-ink-3">
              {status === 'connected' ? 'No active sessions or beacons.' : 'Connect to see live sessions and beacons.'}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {implants.map((im) => (
                <ImplantRow
                  key={`${im.kind}:${im.id}`}
                  im={im}
                  hosts={hosts}
                  pinned={matchOverride[im.id]}
                  onPin={(ip) => setSliverMatch(im.id, ip)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ImplantRow({
  im,
  hosts,
  pinned,
  onPin,
}: {
  im: SliverImplant;
  hosts: Host[];
  pinned: string | undefined;
  onPin: (hostIp: string | null) => void;
}) {
  return (
    <li className="rounded-none border border-line bg-well/50 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span
          className="shrink-0 rounded-none px-1 text-[9px] font-semibold uppercase tracking-wide"
          style={
            im.kind === 'session'
              ? { color: '#4fd88a', border: '1px solid rgba(79,216,138,0.5)' }
              : { color: '#5cc8ff', border: '1px solid rgba(92,200,255,0.5)' }
          }
        >
          {im.kind}
        </span>
        <span className="truncate font-mono text-ink-1">{im.hostname || im.name || im.id}</span>
        {im.isDead && <span className="shrink-0 text-danger">dead</span>}
        <span className="ml-auto shrink-0 text-ink-3">{since(im.lastCheckin)}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[12px] text-ink-2">
        <span>{im.username || '—'}</span>
        <span>
          {im.os}/{im.arch}
        </span>
        <span>{im.transport}</span>
        {im.integrity && <span>{im.integrity}</span>}
        <span className="text-ink-3">pid {im.pid || '—'}</span>
        {im.kind === 'beacon' && im.interval !== undefined && (
          <span className="text-ink-3">
            every {im.interval}s
            {im.jitter ? ` ±${im.jitter}s` : ''}
          </span>
        )}
      </div>
      {im.remoteAddress && <div className="mt-0.5 font-mono text-[11px] text-ink-3">{im.remoteAddress}</div>}
      {im.kind === 'beacon' && <BeaconTimer im={im} />}
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-3">
        <span>match host</span>
        <select
          className="rounded-none border border-line bg-well px-1 py-0.5 text-[11px] text-ink-1 focus:border-accent focus:outline-none"
          value={pinned ?? ''}
          onChange={(e) => onPin(e.target.value || null)}
          title="Pin this implant to a scanned host (overrides auto-matching)"
        >
          <option value="">auto</option>
          {hosts.map((h) => (
            <option key={h.ip} value={h.ip}>
              {displayName(h)}
            </option>
          ))}
        </select>
      </div>
    </li>
  );
}
