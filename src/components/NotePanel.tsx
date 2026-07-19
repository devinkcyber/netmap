import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { displayName, openPorts, subnetOf, type Host } from '../types';
import { renderNote } from '../lib/markdown';
import { isDomainController, adRole, adServices } from '../lib/ad';
import { bloodhoundHostUrl, bloodhoundName } from '../lib/bloodhound';
import { credsForHost } from '../lib/creds';
import { implantsForHost, sinceLabel } from '../lib/sliver';
import BeaconTimer from './BeaconTimer';
import * as vault from '../lib/vault';
import { emit } from '../lib/bus';
import { NET_ID, SCANNER_ID } from '../lib/topology';
import PortsTable from './PortsTable';

const STATUSES = ['unreviewed', 'reviewed', 'owned'] as const;

type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error';

export default function NotePanel() {
  const open = useStore((s) => s.rightOpen);
  const selectedId = useStore((s) => s.selectedId);
  const hosts = useStore((s) => s.hosts);
  const width = useStore((s) => s.notePanelWidth);
  const setSetting = useStore((s) => s.setSetting);

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = useStore.getState().notePanelWidth;
    function move(ev: MouseEvent) {
      // panel is on the right edge, so dragging left (smaller clientX) widens it
      const next = Math.min(760, Math.max(300, startW + (startX - ev.clientX)));
      setSetting('notePanelWidth', next);
    }
    function up() {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
    }
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  if (!open) return null;

  const host = hosts.find((h) => h.ip === selectedId);

  return (
    <aside
      style={{ width }}
      className="absolute inset-y-0 right-0 z-20 flex max-w-full flex-col border-l border-line bg-panel shadow-xl"
    >
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className="absolute left-0 top-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-accent/40 max-md:hidden"
      />
      {host ? (
        <HostPane key={host.ip} host={host} />
      ) : selectedId?.startsWith('subnet:') ? (
        <SubnetPane cidr={selectedId.slice('subnet:'.length)} />
      ) : selectedId === NET_ID || selectedId === SCANNER_ID ? (
        <HubPane id={selectedId} />
      ) : selectedId ? (
        <RouterPane ip={selectedId} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs leading-relaxed text-ink-3">
          Select a node to see its details and its Obsidian note.
        </div>
      )}
    </aside>
  );
}

function HubPane({ id }: { id: string }) {
  const isScanner = id === SCANNER_ID;
  return (
    <div className="p-4">
      <p className="font-mono text-sm text-ink-1">{isScanner ? 'scanner (you)' : 'network'}</p>
      <p className="mt-1 text-xs text-ink-3">
        {isScanner
          ? 'Your scanning host — the root of the traceroute tree.'
          : 'The hub linking every subnet — a synthetic node, not a scanned host.'}
      </p>
    </div>
  );
}

function RouterPane({ ip }: { ip: string }) {
  return (
    <div className="p-4">
      <p className="font-mono text-sm text-ink-1">{ip}</p>
      <p className="mt-1 text-xs text-ink-3">Intermediate hop from traceroute — not a scanned host, so there's no port or note data.</p>
    </div>
  );
}

function SubnetPane({ cidr }: { cidr: string }) {
  const hosts = useStore((s) => s.hosts);
  const mask = useStore((s) => s.mask);
  const members = hosts.filter((h) => subnetOf(h.ip, mask) === cidr);
  return (
    <div className="flex min-h-0 flex-col p-4">
      <p className="font-mono text-sm text-ink-1">{cidr}</p>
      <p className="mt-1 text-xs text-ink-3">
        Subnet group · {members.length} host{members.length === 1 ? '' : 's'}
      </p>
      <ul className="mt-3 space-y-0.5 overflow-y-auto">
        {members.map((h) => (
          <li key={h.ip}>
            <button
              className="flex w-full items-baseline gap-2 rounded-none px-2 py-1 text-left text-xs hover:bg-raise"
              onClick={() => emit('focus', h.ip)}
              title="Jump to this host"
            >
              <span className="font-mono text-ink-1">{h.ip}</span>
              <span className="truncate text-ink-2">{displayName(h) !== h.ip ? displayName(h) : ''}</span>
              <span className="ml-auto shrink-0 font-mono text-ink-3">{openPorts(h).length} open</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HostPane({ host }: { host: Host }) {
  const [tab, setTab] = useState<'note' | 'ports'>('note');
  return (
    <>
      <HostHeader host={host} />
      <div className="flex border-b border-line text-xs">
        <TabBtn active={tab === 'note'} onClick={() => setTab('note')}>
          Note
        </TabBtn>
        <TabBtn active={tab === 'ports'} onClick={() => setTab('ports')}>
          Ports ({host.ports.length})
        </TabBtn>
      </div>
      {tab === 'note' ? <NoteSection host={host} /> : <PortsTable host={host} />}
    </>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={`border-b-2 px-4 py-2 transition-colors ${active ? 'border-accent text-ink-1' : 'border-transparent text-ink-3 hover:text-ink-1'}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function HostHeader({ host }: { host: Host }) {
  const status = useStore((s) => s.noteStatusByIp[host.ip]);
  const bloodhoundUrl = useStore((s) => s.bloodhoundUrl);
  const bhId = useStore((s) => s.noteBhIdByIp[host.ip]);
  const users = useStore((s) => s.users);
  const setUi = useStore((s) => s.setUi);
  const ligolo = useStore((s) => s.ligoloByIp[host.ip]);
  const toggleLigolo = useStore((s) => s.toggleLigolo);
  const dcManual = useStore((s) => host.ip in s.dcOverrideByIp); // re-render on DC override changes
  const sliverImplants = useStore((s) => s.sliverImplants);
  const sliverMatchOverride = useStore((s) => s.sliverMatchOverride);
  const creds = credsForHost(host, users);
  const implants = implantsForHost(host, sliverImplants, sliverMatchOverride).filter((i) => !i.isDead);
  return (
    <div className="border-b border-line p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate font-display text-[15px] font-semibold text-ink-1">{displayName(host)}</h2>
            {isDomainController(host) && (
              <span
                className="shrink-0 rounded-none border border-warn/60 px-1 text-[9px] font-semibold uppercase tracking-wide text-warn"
                title={dcManual ? 'Domain Controller (manually marked)' : 'Detected Domain Controller'}
              >
                DC
              </span>
            )}
            {ligolo && (
              <span
                className="shrink-0 rounded-none px-1 text-[9px] font-semibold uppercase tracking-wide"
                style={{ color: '#e879c7', border: '1px solid rgba(232,121,199,0.5)' }}
                title="Ligolo pivot agent on this host"
              >
                Ligolo
              </span>
            )}
          </div>
          <p className="font-mono text-xs text-ink-2">{host.ip}</p>
        </div>
        {status && <StatusPill status={status} />}
      </div>
      <dl className="mt-2 space-y-0.5 text-[12px] text-ink-2">
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-ink-3">AD role</dt>
          <dd>{adRole(host)}</dd>
        </div>
        {adServices(host).length > 0 && (
          <div className="flex gap-2">
            <dt className="w-14 shrink-0 text-ink-3">AD svc</dt>
            <dd className="truncate font-mono">{adServices(host).join(', ')}</dd>
          </div>
        )}
        {host.os && (
          <div className="flex gap-2">
            <dt className="w-14 shrink-0 text-ink-3">OS</dt>
            <dd className="truncate">{host.os}{host.osAccuracy ? ` (${host.osAccuracy}%)` : ''}</dd>
          </div>
        )}
        {host.mac && (
          <div className="flex gap-2">
            <dt className="w-14 shrink-0 text-ink-3">MAC</dt>
            <dd className="truncate font-mono">
              {host.mac}
              {host.vendor && <span className="ml-1 font-sans text-ink-3">{host.vendor}</span>}
            </dd>
          </div>
        )}
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-ink-3">Open</dt>
          <dd className="font-mono">{openPorts(host).length} ports</dd>
        </div>
        {host.lastSeen && (
          <div className="flex gap-2">
            <dt className="w-14 shrink-0 text-ink-3">Seen</dt>
            <dd>{new Date(host.lastSeen).toLocaleString()}</dd>
          </div>
        )}
      </dl>
      {creds.length > 0 && (
        <div className="mt-3 rounded-none border border-line bg-well/60 p-2">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
            <span aria-hidden>🔑</span> Credentials on this host
          </div>
          <ul className="space-y-0.5">
            {creds.map((c, i) => (
              <li key={`${c.username}-${i}`} className="flex items-baseline justify-between gap-2 font-mono text-[12px]">
                <span className="truncate text-ink-1">{c.username}</span>
                <span className="shrink-0 text-ink-2">{c.password ? c.password : <span className="text-ink-3">— no password —</span>}</span>
              </li>
            ))}
          </ul>
          <button className="mt-1.5 text-[11px] text-accent hover:underline" onClick={() => setUi({ usersOpen: true })}>
            Manage users →
          </button>
        </div>
      )}
      {implants.length > 0 && (
        <div className="mt-3 rounded-none border p-2" style={{ borderColor: 'rgba(255,59,92,0.4)', background: 'rgba(255,59,92,0.06)' }}>
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: '#ff6478' }}>
            <span aria-hidden>◉</span> Sliver C2 on this host
          </div>
          <ul className="space-y-1">
            {implants.map((im) => (
              <li key={`${im.kind}:${im.id}`} className="font-mono text-[12px]">
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] uppercase tracking-wide" style={{ color: im.kind === 'session' ? '#4fd88a' : '#5cc8ff' }}>
                    {im.kind}
                  </span>
                  <span className="truncate text-ink-1">{im.username || '—'}</span>
                  {im.integrity && <span className="text-ink-3">{im.integrity}</span>}
                  <span className="ml-auto shrink-0 text-ink-3">{sinceLabel(im.lastCheckin)}</span>
                </div>
                <div className="text-ink-2">
                  {im.os}/{im.arch} · {im.transport} · pid {im.pid || '—'}
                  {im.kind === 'beacon' && im.interval !== undefined ? ` · every ${im.interval}s${im.jitter ? ` ±${im.jitter}s` : ''}` : ''}
                </div>
                {im.kind === 'beacon' && <BeaconTimer im={im} />}
              </li>
            ))}
          </ul>
          <button className="mt-1.5 text-[11px] text-accent hover:underline" onClick={() => setUi({ sliverOpen: true })}>
            Sliver panel →
          </button>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a
          className="btn inline-flex items-center gap-1"
          href={bloodhoundHostUrl(bloodhoundUrl, host, bhId)}
          target="_blank"
          rel="noopener noreferrer"
          title={bhId ? `Open ${bhId} in BloodHound CE` : `Search ${bloodhoundName(host)} in BloodHound CE`}
        >
          Open in BloodHound
          <span aria-hidden>↗</span>
        </a>
        <button
          className="btn inline-flex items-center gap-1"
          onClick={() => toggleLigolo(host.ip)}
          style={ligolo ? { color: '#e879c7', borderColor: 'rgba(232,121,199,0.5)' } : undefined}
          title="Toggle the Ligolo pivot flag for this host (also available by right-clicking the node)"
        >
          <span aria-hidden>📡</span>
          {ligolo ? 'Ligolo agent' : 'Mark Ligolo'}
        </button>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const color =
    status === 'owned' ? 'text-danger border-danger/50' : status === 'reviewed' ? 'text-ok border-ok/50' : 'text-ink-2 border-line';
  return <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${color}`}>{status}</span>;
}

// ---------------- note section ----------------

function NoteSection({ host }: { host: Host }) {
  const vaultName = useStore((s) => s.vaultName);
  const editMode = useStore((s) => s.noteEditMode);
  const expanded = useStore((s) => s.noteEditorExpanded);
  const setUi = useStore((s) => s.setUi);
  const hostsFolder = useStore((s) => s.hostsFolder);
  const scanMeta = useStore((s) => s.scanMeta);
  const setVault = useStore((s) => s.setVault);
  const showToast = useStore((s) => s.showToast);
  const select = useStore((s) => s.select);

  const [ref, setRef] = useState<vault.NoteRef | null | undefined>(undefined); // undefined = loading
  const [content, setContent] = useState('');
  const [bhInput, setBhInput] = useState('');
  const [save, setSave] = useState<SaveState>('clean');
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const latest = useRef({ content: '', ref: null as vault.NoteRef | null });

  // Load the note for this host
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = vault.noteForIp(host.ip) ?? null;
      if (r) {
        const text = await vault.readNote(r).catch(() => '');
        if (!cancelled) {
          const fm = vault.parseFrontmatter(text.slice(0, 2000));
          setRef(r);
          setContent(text);
          setBhInput(fm.bloodhound_id ?? fm.objectid ?? '');
          latest.current = { content: text, ref: r };
          setSave('clean');
        }
      } else if (!cancelled) {
        setRef(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host.ip, vaultName]);

  const doSave = useCallback(async () => {
    const { content: c, ref: r } = latest.current;
    if (!r) return;
    setSave('saving');
    try {
      await vault.writeNote(r, c);
      setSave('saved');
      useStore.setState((s) => {
        const fm = vault.parseFrontmatter(c.slice(0, 2000));
        const next = { ...s.noteStatusByIp };
        if (fm.status) next[host.ip] = fm.status;
        else delete next[host.ip];
        const nextBh = { ...s.noteBhIdByIp };
        const bhId = fm.bloodhound_id ?? fm.objectid;
        if (bhId) nextBh[host.ip] = bhId;
        else delete nextBh[host.ip];
        return { noteStatusByIp: next, noteBhIdByIp: nextBh };
      });
    } catch {
      setSave('error');
    }
  }, [host.ip]);

  function onChange(v: string) {
    setContent(v);
    latest.current.content = v;
    setSave('dirty');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(doSave, 1200); // debounced autosave
  }

  // flush pending save on unmount / host switch
  useEffect(
    () => () => {
      clearTimeout(saveTimer.current);
      if (latest.current.ref && latest.current.content && save === 'dirty') void doSave();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [host.ip],
  );

  // Ctrl/Cmd+S explicit save
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        clearTimeout(saveTimer.current);
        void doSave();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doSave]);

  async function create() {
    try {
      const date = scanMeta?.startstr ? new Date(scanMeta.startstr).toISOString().slice(0, 10) : undefined;
      const r = await vault.createNote(host, hostsFolder, date);
      const text = await vault.readNote(r);
      setRef(r);
      setContent(text);
      setBhInput(vault.parseFrontmatter(text.slice(0, 2000)).bloodhound_id ?? '');
      latest.current = { content: text, ref: r };
      const counts = await vault.rebuildIndex();
      setVault(vault.vaultName(), counts, vault.statusByIp(), vault.bloodhoundIdByIp());
      showToast(`Created ${r.path}`);
    } catch (e) {
      showToast(`Could not create the note: ${(e as Error).message}`);
    }
  }

  async function setStatus(status: string) {
    const next = vault.setFrontmatterField(latest.current.content, 'status', status);
    onChange(next);
    clearTimeout(saveTimer.current);
    latest.current.content = next;
    setContent(next);
    await doSave();
  }

  // Write the BloodHound object ID into the note's frontmatter (drives the exact deep-link).
  async function commitBhId() {
    const id = bhInput.trim();
    const fm = vault.parseFrontmatter(latest.current.content.slice(0, 2000));
    if (id === (fm.bloodhound_id ?? fm.objectid ?? '')) return; // unchanged
    const next = vault.setFrontmatterField(latest.current.content, 'bloodhound_id', id);
    clearTimeout(saveTimer.current);
    latest.current.content = next;
    setContent(next);
    await doSave();
  }

  const previewRef = useRef<HTMLDivElement>(null);

  // Resolve vault-relative <img> sources (e.g. pasted attachments) to blob URLs.
  useEffect(() => {
    if (editMode) return;
    const el = previewRef.current;
    if (!el) return;
    let cancelled = false;
    const urls: string[] = [];
    el.querySelectorAll('img').forEach((img) => {
      const raw = img.getAttribute('src') ?? '';
      if (!raw || /^(https?:|data:|blob:)/i.test(raw)) return;
      void vault.readBinary(decodeURIComponent(raw)).then((blob) => {
        if (!blob || cancelled) return;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        img.src = url;
      });
    });
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [content, editMode]);

  async function onPasteImage(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
    if (!item) return; // let normal text paste proceed
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    try {
      const ext = (file.type.split('/')[1] || 'png').replace('+xml', '');
      const path = await vault.saveAttachment(file, ext);
      const snippet = `\n![pasted image](${path})\n`;
      const next = content.slice(0, start) + snippet + content.slice(end);
      onChange(next);
      showToast(`Saved image to ${path}`);
      requestAnimationFrame(() => {
        ta.focus();
        const pos = start + snippet.length;
        ta.setSelectionRange(pos, pos);
      });
    } catch (err) {
      showToast(`Could not save pasted image: ${(err as Error).message}`);
    }
  }

  function onPreviewClick(e: React.MouseEvent) {
    const a = (e.target as HTMLElement).closest('a[data-wikilink]');
    if (!a) return;
    e.preventDefault();
    const target = a.getAttribute('data-wikilink')!;
    const linked = vault.noteByName(target);
    if (!linked) {
      showToast(`No note named "${target}" in the vault.`);
      return;
    }
    if (linked.ip && useStore.getState().hosts.some((h) => h.ip === linked.ip)) {
      select(linked.ip);
      emit('focus', linked.ip);
    } else {
      showToast(`"${target}" isn't a scanned host — opening isn't wired to the graph.`);
    }
  }

  if (!vaultName) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-xs leading-relaxed text-ink-2">
          Connect your Obsidian vault (top bar) to read and edit the note for <span className="font-mono">{host.ip}</span> right here.
        </p>
        <p className="text-[12px] text-ink-3">Notes match by frontmatter `ip:`/`host:`, or a filename equal to the IP.</p>
      </div>
    );
  }
  if (ref === undefined) return <div className="p-4 text-xs text-ink-3">Loading note…</div>;
  if (ref === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-xs text-ink-2">No note in the vault for <span className="font-mono">{host.ip}</span>.</p>
        <button className="btn-primary" onClick={create}>
          Create note in {hostsFolder}/
        </button>
      </div>
    );
  }

  const editor = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
        <button className={`btn-mini ${!editMode ? 'btn-mini-active' : ''}`} onClick={() => setUi({ noteEditMode: false })}>
          Preview
        </button>
        <button className={`btn-mini ${editMode ? 'btn-mini-active' : ''}`} onClick={() => setUi({ noteEditMode: true })} title="Toggle with `e`">
          Edit
        </button>
        <span className="mx-1 h-4 w-px bg-line" />
        {STATUSES.map((s) => (
          <button key={s} className="btn-mini" title={`Set status: ${s}`} onClick={() => setStatus(s)}>
            {s[0].toUpperCase()}
          </button>
        ))}
        <button
          className={`btn-mini ml-auto ${expanded ? 'btn-mini-active' : ''}`}
          title={expanded ? 'Collapse the editor back into the sidebar' : 'Open the note in a large full-screen editor'}
          onClick={() => setUi({ noteEditorExpanded: !expanded })}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
        <span className={`text-[11px] ${save === 'error' ? 'text-danger' : 'text-ink-3'}`}>
          {save === 'dirty' && 'unsaved'}
          {save === 'saving' && 'saving…'}
          {save === 'saved' && 'saved'}
          {save === 'error' && 'save failed'}
        </span>
      </div>
      <p className="border-b border-line px-3 py-1 font-mono text-[11px] text-ink-3">{ref.path}</p>
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="shrink-0 text-[11px] text-ink-3" title="BloodHound node object ID (SID/GUID). Paste it for an exact deep-link.">
          BH&nbsp;ID
        </span>
        <input
          value={bhInput}
          spellCheck={false}
          placeholder="S-1-5-21-… (optional)"
          onChange={(e) => setBhInput(e.target.value)}
          onBlur={commitBhId}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          className="min-w-0 flex-1 rounded-none border border-line bg-well px-2 py-0.5 font-mono text-[11px] text-ink-1 placeholder:text-ink-3 focus:border-accent focus:outline-none"
        />
      </div>
      {editMode ? (
        <textarea
          className="min-h-0 flex-1 resize-none bg-well p-3 font-mono text-xs leading-relaxed text-ink-1 focus:outline-none"
          value={content}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPasteImage}
          title="Paste an image from the clipboard to embed it in this note"
        />
      ) : (
        <div
          ref={previewRef}
          className="prose-note min-h-0 flex-1 overflow-y-auto p-4"
          onClick={onPreviewClick}
          dangerouslySetInnerHTML={{ __html: renderNote(content) }}
        />
      )}
    </div>
  );

  // Expanded: blow the same editor up into a large near-fullscreen modal (single instance,
  // so all editing state / autosave / paste-image carry over unchanged).
  if (expanded) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setUi({ noteEditorExpanded: false })}>
        <div
          className="flex h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-none border border-line bg-panel shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {editor}
        </div>
      </div>
    );
  }
  return editor;
}
