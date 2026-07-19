import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { displayName } from '../types';
import { renderNote } from '../lib/markdown';
import * as vault from '../lib/vault';
import { emit } from '../lib/bus';
import { useFocusTrap } from '../lib/useFocusTrap';

/**
 * A large, distraction-free reader for the selected host's Obsidian note.
 * Loads the note fresh from the vault (so it reflects the last saved content),
 * renders the markdown wide, resolves embedded images, and handles wikilinks.
 */
export default function NoteViewerModal() {
  const open = useStore((s) => s.noteViewerOpen);
  const selectedId = useStore((s) => s.selectedId);
  const hosts = useStore((s) => s.hosts);
  const vaultName = useStore((s) => s.vaultName);
  const setUi = useStore((s) => s.setUi);
  const select = useStore((s) => s.select);
  const showToast = useStore((s) => s.showToast);

  const host = hosts.find((h) => h.ip === selectedId);
  const [content, setContent] = useState<string | null>(null); // null = loading
  const [path, setPath] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, panelRef);

  function close() {
    setUi({ noteViewerOpen: false });
  }

  // Load the note whenever the viewer opens for a host.
  useEffect(() => {
    if (!open || !host) return;
    let cancelled = false;
    setContent(null);
    setPath(null);
    (async () => {
      const ref = vault.noteForIp(host.ip);
      const text = ref ? await vault.readNote(ref).catch(() => '') : '';
      if (!cancelled) {
        setContent(text);
        setPath(ref?.path ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on the host's IP, not the host object's identity, which is what actually changes the note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, host?.ip]);

  // (Escape-to-close is handled centrally in App's keyboard handler.)

  // Resolve vault-relative <img> sources to blob URLs.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || content === null) return;
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
  }, [content]);

  function onBodyClick(e: React.MouseEvent) {
    const a = (e.target as HTMLElement).closest('a[data-wikilink]');
    if (!a) return;
    e.preventDefault();
    const target = a.getAttribute('data-wikilink')!;
    const linked = vault.noteByName(target);
    if (linked?.ip && useStore.getState().hosts.some((h) => h.ip === linked.ip)) {
      select(linked.ip);
      emit('focus', linked.ip);
    } else {
      showToast(`"${target}" isn't a scanned host.`);
    }
  }

  if (!open || !host) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={close}>
      <div
        ref={panelRef}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-none border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between gap-3 border-b border-line px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate font-display text-lg font-semibold text-ink-1">{displayName(host)}</h2>
            {path && <p className="truncate font-mono text-[12px] text-ink-3">{path}</p>}
          </div>
          <button className="shrink-0 text-xs text-ink-3 hover:text-ink-1" onClick={close}>
            Close (Esc)
          </button>
        </div>

        {!vaultName ? (
          <p className="p-10 text-center text-sm text-ink-2">Connect your Obsidian vault to read notes here.</p>
        ) : content === null ? (
          <p className="p-10 text-center text-sm text-ink-3">Loading note…</p>
        ) : content.trim() === '' ? (
          <p className="p-10 text-center text-sm text-ink-2">
            No note in the vault for <span className="font-mono">{host.ip}</span> yet.
          </p>
        ) : (
          <div
            ref={bodyRef}
            className="prose-note min-h-0 flex-1 overflow-y-auto px-8 py-6 text-[15px] leading-relaxed"
            onClick={onBodyClick}
            dangerouslySetInnerHTML={{ __html: renderNote(content) }}
          />
        )}
      </div>
    </div>
  );
}
