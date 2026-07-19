import { useRef, useState } from 'react';
import { useStore } from '../store';
import { parseNmapXml } from '../lib/parseNmap';
import { hasTraceroute } from '../lib/topology';
import { useFocusTrap } from '../lib/useFocusTrap';

export default function ImportModal() {
  const open = useStore((s) => s.importOpen);
  const setUi = useStore((s) => s.setUi);
  const setScan = useStore((s) => s.setScan);
  const showToast = useStore((s) => s.showToast);
  const hasData = useStore((s) => s.hosts.length > 0);

  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, panelRef);

  if (!open) return null;

  function ingest(xml: string) {
    setError(null);
    try {
      const { hosts, meta, warnings } = parseNmapXml(xml);
      if (hosts.length === 0) {
        setError('The file parsed, but no hosts were found in it.');
        return;
      }
      const trace = hasTraceroute(hosts);
      setScan(hosts, meta, trace);
      setPasted('');
      showToast(
        `Loaded ${hosts.length} host${hosts.length === 1 ? '' : 's'}` +
          (trace ? ' · traceroute paths found' : ' · no traceroute, grouping by subnet') +
          (warnings.length ? ` · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''),
      );
      if (warnings.length) console.warn('nmap import warnings:', warnings);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function fromFile(file: File | undefined) {
    if (!file) return;
    ingest(await file.text());
  }

  async function loadSample() {
    setError(null);
    try {
      // BASE_URL respects the deploy sub-path (e.g. `/netmap/` on GitHub Pages),
      // so the sample resolves under the app base rather than the domain root.
      const res = await fetch(`${import.meta.env.BASE_URL}sample-scan.xml`);
      if (!res.ok) throw new Error(`Could not load the sample scan (HTTP ${res.status}).`);
      ingest(await res.text());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => hasData && setUi({ importOpen: false })}>
      <div ref={panelRef} className="w-full max-w-lg rounded-none border border-line bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="font-display text-base font-semibold text-ink-1">Import nmap scan</h2>
          {hasData && (
            <button className="text-xs text-ink-3 hover:text-ink-1" onClick={() => setUi({ importOpen: false })}>
              Close
            </button>
          )}
        </div>
        <p className="mb-4 text-xs leading-relaxed text-ink-2">
          Export from nmap with <code className="rounded-none bg-well px-1 py-0.5 font-mono">-oX scan.xml</code>. Add{' '}
          <code className="rounded-none bg-well px-1 py-0.5 font-mono">--traceroute</code> for real topology edges,{' '}
          <code className="rounded-none bg-well px-1 py-0.5 font-mono">-sV -O</code> for services and OS. All optional.
        </p>

        <div
          className={`flex cursor-pointer flex-col items-center justify-center rounded-none border-2 border-dashed px-4 py-8 text-center transition-colors ${
            dragging ? 'border-accent bg-accent/5' : 'border-line hover:border-ink-3'
          }`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            fromFile(e.dataTransfer.files?.[0]);
          }}
        >
          <p className="text-sm text-ink-1">Drop your .xml here, or click to pick a file</p>
          <p className="mt-1 font-mono text-[12px] text-ink-3">nmap -oX output</p>
          <input ref={fileRef} type="file" accept=".xml,text/xml,application/xml" className="hidden" onChange={(e) => fromFile(e.target.files?.[0] ?? undefined)} />
        </div>

        <div className="mt-4">
          <label className="mb-1 block text-[12px] font-medium uppercase tracking-wide text-ink-3">Or paste XML</label>
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={4}
            spellCheck={false}
            placeholder="<?xml version=&quot;1.0&quot;?> <nmaprun …"
            className="w-full resize-y rounded-none border border-line bg-well p-2 font-mono text-[12px] text-ink-1 placeholder:text-ink-3 focus:border-accent focus:outline-none"
          />
          <div className="mt-2 flex items-center gap-2">
            <button className="btn-primary" disabled={!pasted.trim()} onClick={() => ingest(pasted)}>
              Parse pasted XML
            </button>
            <button className="btn" onClick={loadSample}>
              Load sample scan
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded-none border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>
        )}
      </div>
    </div>
  );
}
