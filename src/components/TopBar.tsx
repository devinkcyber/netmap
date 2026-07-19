import { useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { emit } from '../lib/bus';
import { displayName, openPorts } from '../types';
import { hasTraceroute } from '../lib/topology';
import * as vault from '../lib/vault';

export default function TopBar() {
  const hosts = useStore((s) => s.hosts);
  const mode = useStore((s) => s.topologyMode);
  const layout = useStore((s) => s.layout);
  const theme = useStore((s) => s.theme);
  const vaultName = useStore((s) => s.vaultName);
  const userCount = useStore((s) => s.users.length);
  const credProtected = useStore((s) => s.credProtected);
  const credLocked = useStore((s) => s.credLocked);
  const sliverStatus = useStore((s) => s.sliverStatus);
  const sliverCount = useStore((s) => s.sliverImplants.length);
  const setSetting = useStore((s) => s.setSetting);
  const setUi = useStore((s) => s.setUi);
  const setVault = useStore((s) => s.setVault);
  const showToast = useStore((s) => s.showToast);

  const traceAvailable = useMemo(() => hasTraceroute(hosts), [hosts]);

  async function connectVault() {
    // Browsers without the File System Access API (Firefox, Safari) connect through the
    // local vault bridge instead. `?vaultbridge` forces the bridge path on Chromium too.
    if (!vault.isFsaSupported() || new URLSearchParams(location.search).has('vaultbridge')) {
      setUi({ vaultBridgeOpen: true });
      return;
    }
    try {
      const restored = await vault.restoreVault(true);
      const name = restored ?? (await vault.pickVault());
      const counts = await vault.rebuildIndex();
      setVault(name, counts, vault.statusByIp(), vault.bloodhoundIdByIp());
      showToast(`Vault "${name}" connected — ${counts.notes} notes, ${counts.matched} matched to hosts.`);
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') showToast('Could not open the vault folder.');
    }
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
      <button
        className="rounded-none p-1.5 text-ink-2 hover:bg-raise hover:text-ink-1"
        title="Toggle controls"
        onClick={() => setUi({ leftOpen: !useStore.getState().leftOpen })}
      >
        <Icon d="M3 5h14M3 10h14M3 15h14" />
      </button>

      <span className="mr-2 select-none font-display text-[15px] font-semibold tracking-tight text-ink-1">
        net<span className="text-accent">map</span>
      </span>

      <button className="btn-primary" onClick={() => setUi({ importOpen: true })}>
        Import scan
      </button>

      <button className="btn" onClick={connectVault} title="Pick your Obsidian vault folder (read/write)">
        {vaultName ? (
          <>
            <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-ok" /> {vaultName}
          </>
        ) : (
          'Connect vault'
        )}
      </button>

      <button
        className="btn"
        onClick={() => setUi({ usersOpen: true })}
        title={credProtected ? `AD users & credentials — ${credLocked ? 'locked' : 'encrypted'}` : 'AD users & credentials'}
      >
        Users
        {credProtected && (
          <span className="ml-1" aria-hidden>
            {credLocked ? '🔒' : '🔓'}
          </span>
        )}
        {userCount > 0 && <span className="ml-1.5 text-ink-3">{userCount}</span>}
      </button>

      <button className="btn inline-flex items-center gap-1.5" onClick={() => setUi({ sliverOpen: true })} title="Sliver C2">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            sliverStatus === 'connected' ? 'bg-ok' : sliverStatus === 'connecting' ? 'bg-warn' : sliverStatus === 'error' ? 'bg-danger' : 'bg-ink-3'
          }`}
        />
        Sliver{sliverStatus === 'connected' && sliverCount > 0 && <span className="text-ink-3">{sliverCount}</span>}
      </button>

      <div className="mx-1 h-5 w-px bg-line" />

      {/* Topology toggle */}
      <div className="flex overflow-hidden rounded-none border border-line text-xs">
        <ToggleSeg
          active={mode === 'trace'}
          disabled={!traceAvailable}
          title={traceAvailable ? 'Real paths from --traceroute hops' : 'No traceroute data in this scan'}
          onClick={() => setSetting('topologyMode', 'trace')}
        >
          Traceroute
        </ToggleSeg>
        <ToggleSeg active={mode === 'subnet'} onClick={() => setSetting('topologyMode', 'subnet')} title="Group hosts by inferred subnet">
          Subnets
        </ToggleSeg>
      </div>

      <select
        className="select"
        value={layout}
        onChange={(e) => setSetting('layout', e.target.value as never)}
        title="Layout algorithm"
      >
        <option value="cose">Force (cose)</option>
        <option value="concentric">Concentric</option>
        <option value="breadthfirst">Tree</option>
      </select>

      <SearchBox />

      <div className="ml-auto flex items-center gap-1.5">
        <button className="btn" onClick={() => emit('fit')} title="Fit to screen (f)">
          Fit
        </button>
        <button
          className="btn"
          onClick={() => emit('reset-layout')}
          title="Reset node positions to the auto layout (discards manual moves)"
          disabled={hosts.length === 0}
        >
          Reset
        </button>
        <button className="btn" onClick={() => emit('export-png')} title="Export the diagram as PNG" disabled={hosts.length === 0}>
          Export PNG
        </button>
        <button
          className="rounded-none p-1.5 text-ink-2 hover:bg-raise hover:text-ink-1"
          title="Keyboard &amp; mouse shortcuts (?)"
          onClick={() => setUi({ helpOpen: true })}
        >
          <span className="flex h-[18px] w-[18px] items-center justify-center font-mono text-sm font-bold leading-none">?</span>
        </button>
        <button
          className="rounded-none p-1.5 text-ink-2 hover:bg-raise hover:text-ink-1"
          title="Toggle theme"
          onClick={() => setSetting('theme', theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <Icon d="M10 3v2M10 15v2M3 10h2M15 10h2M5 5l1.5 1.5M13.5 13.5L15 15M15 5l-1.5 1.5M6.5 13.5L5 15M10 7a3 3 0 100 6 3 3 0 000-6z" /> : <Icon d="M15.5 11.5A6 6 0 018.5 4.5 6.5 6.5 0 1015.5 11.5z" />}
        </button>
        <button
          className="rounded-none p-1.5 text-ink-2 hover:bg-raise hover:text-ink-1"
          title="Toggle note panel"
          onClick={() => setUi({ rightOpen: !useStore.getState().rightOpen })}
        >
          <Icon d="M12 3h5v14h-5M3 3h9v14H3z" />
        </button>
      </div>
    </header>
  );
}

function SearchBox() {
  const hosts = useStore((s) => s.hosts);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    // Comma-separated terms are OR'd: "dc01,web01" lists hosts matching either.
    const terms = q.toLowerCase().split(',').map((t) => t.trim()).filter(Boolean);
    if (!terms.length) return [];
    return hosts
      .filter((h) => {
        const hay = [h.ip, ...h.hostnames, ...h.ports.map((p) => p.service ?? '')].join(' ').toLowerCase();
        return terms.some((t) => hay.includes(t));
      })
      .slice(0, 8);
  }, [q, hosts]);

  function jump(id: string) {
    emit('focus', id);
    setOpen(false);
    setQ('');
    inputRef.current?.blur();
  }

  return (
    <div className="relative w-56">
      <input
        id="global-search"
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches[0]) jump(matches[0].ip);
          if (e.key === 'Escape') {
            setQ('');
            inputRef.current?.blur();
          }
        }}
        placeholder="Jump to IP, host, service…  ( / )"
        className="w-full rounded-none border border-line bg-well px-2.5 py-1.5 font-mono text-xs text-ink-1 placeholder:text-ink-3 focus:border-accent focus:outline-none"
      />
      {open && matches.length > 0 && (
        <ul className="absolute top-full z-30 mt-1 w-72 overflow-hidden rounded-none border border-line bg-panel shadow-xl">
          {matches.map((h) => (
            <li key={h.ip}>
              <button
                className="flex w-full items-baseline gap-2 px-3 py-2 text-left text-xs hover:bg-raise"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => jump(h.ip)}
              >
                <span className="font-mono text-ink-1">{h.ip}</span>
                <span className="truncate text-ink-2">{displayName(h) !== h.ip ? displayName(h) : ''}</span>
                <span className="ml-auto shrink-0 font-mono text-ink-3">{openPorts(h).length} open</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ToggleSeg({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`px-2.5 py-1.5 font-mono text-[12px] uppercase tracking-wide transition-colors ${
        active ? 'bg-accent/15 text-accent' : 'text-ink-2 hover:bg-raise hover:text-ink-1'
      } disabled:cursor-not-allowed disabled:opacity-40`}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
