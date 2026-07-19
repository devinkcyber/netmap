import { useRef, type ReactNode } from 'react';
import { useStore } from '../store';
import { useFocusTrap } from '../lib/useFocusTrap';

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.4rem] items-center justify-center rounded-none border border-line bg-well px-1.5 py-0.5 font-mono text-[11px] leading-none text-ink-1">
      {children}
    </kbd>
  );
}

function Row({ keys, children }: { keys: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9.5rem_1fr] items-baseline gap-x-4 py-1">
      <div className="flex flex-wrap items-center gap-1">{keys}</div>
      <div className="text-xs text-ink-2">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 font-display text-[11px] font-semibold uppercase tracking-wide text-ink-3">{title}</h3>
      {children}
    </div>
  );
}

const mod = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';

export default function ShortcutsModal() {
  const open = useStore((s) => s.helpOpen);
  const setUi = useStore((s) => s.setUi);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, panelRef);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setUi({ helpOpen: false })}>
      <div
        ref={panelRef}
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-none border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between border-b border-line p-5 pb-3">
          <h2 className="font-display text-base font-semibold text-ink-1">Keyboard &amp; mouse</h2>
          <button className="text-xs text-ink-3 hover:text-ink-1" onClick={() => setUi({ helpOpen: false })}>
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <Section title="Graph">
            <Row keys={<Key>/</Key>}>Focus search — jump to an IP, host, or service</Row>
            <Row keys={<Key>f</Key>}>Fit the whole graph to the screen</Row>
            <Row
              keys={
                <>
                  <Key>↑</Key>
                  <Key>↓</Key>
                  <Key>←</Key>
                  <Key>→</Key>
                </>
              }
            >
              Move the selection to the next node
            </Row>
            <Row keys={<><Key>Shift</Key><span className="text-ink-3">+ drag</span></>}>
              Move a group — a subnet's hosts, a router's subtree, or the scanner's first hops
            </Row>
            <Row keys={<span className="text-ink-3">Right-click</span>}>
              Host actions — mark DC, open in BloodHound, Ligolo pivot &amp; unlocked subnets
            </Row>
            <Row keys={<span className="text-ink-3">Click</span>}>Select a node and highlight its edges</Row>
          </Section>

          <Section title="Notes">
            <Row keys={<Key>e</Key>}>Toggle note edit / preview</Row>
            <Row keys={<><Key>{mod}</Key><Key>S</Key></>}>Save the note (it also autosaves)</Row>
          </Section>

          <Section title="General">
            <Row keys={<Key>?</Key>}>Toggle this help</Row>
            <Row keys={<Key>Esc</Key>}>Close a dialog / cancel linking</Row>
          </Section>

          <p className="border-t border-line pt-3 text-[11px] leading-relaxed text-ink-3">
            No Sliver server? Open <span className="text-ink-2">Sliver C2 → Load demo implants</span> to preview the C2 overlay.
          </p>
        </div>
      </div>
    </div>
  );
}
