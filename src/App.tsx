import { useEffect } from 'react';
import { useStore } from './store';
import TopBar from './components/TopBar';
import LeftRail from './components/LeftRail';
import Graph from './components/Graph';
import NotePanel from './components/NotePanel';
import ImportModal from './components/ImportModal';
import UsersModal from './components/UsersModal';
import ErrorBoundary from './components/ErrorBoundary';
import NoteViewerModal from './components/NoteViewerModal';
import SliverModal from './components/SliverModal';
import VaultBridgeModal from './components/VaultBridgeModal';
import ShortcutsModal from './components/ShortcutsModal';
import * as vault from './lib/vault';
import { restoreSliver } from './lib/sliver';
import { emit } from './lib/bus';

export default function App() {
  const theme = useStore((s) => s.theme);
  const toast = useStore((s) => s.toast);
  const setVault = useStore((s) => s.setVault);

  // theme class on <html>
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // Silently restore a previously connected vault: the File System Access handle if permission
  // is still granted, otherwise a previously-configured vault bridge (Firefox/Safari path).
  useEffect(() => {
    (async () => {
      let name = await vault.restoreVault(false).catch(() => null);
      if (!name) {
        const { vaultBridgeUrl, vaultBridgeToken } = useStore.getState();
        if (vaultBridgeToken) name = await vault.restoreBridge(vaultBridgeUrl, vaultBridgeToken).catch(() => null);
      }
      if (name) {
        const counts = await vault.rebuildIndex();
        setVault(name, counts, vault.statusByIp(), vault.bloodhoundIdByIp());
      }
    })();
  }, [setVault]);

  // Reconnect to the Sliver bridge if it was enabled last session.
  useEffect(() => {
    restoreSliver();
  }, []);

  // Keyboard shortcuts: Esc closes the open modal, / search, f fit, e edit toggle.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const s = useStore.getState();
      const modalOpen = s.importOpen || s.usersOpen || s.sliverOpen || s.vaultBridgeOpen || s.noteViewerOpen || s.helpOpen || s.noteEditorExpanded;

      if (e.key === 'Escape') {
        // The import modal can't be dismissed until a scan is loaded.
        const hasData = s.hosts.length > 0;
        if (s.usersOpen || s.sliverOpen || s.vaultBridgeOpen || s.noteViewerOpen || s.helpOpen || s.noteEditorExpanded || (s.importOpen && hasData)) {
          e.preventDefault();
          s.setUi({ usersOpen: false, sliverOpen: false, vaultBridgeOpen: false, noteViewerOpen: false, helpOpen: false, noteEditorExpanded: false, ...(hasData ? { importOpen: false } : {}) });
        }
        return;
      }

      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      // `?` toggles the shortcuts overlay — open when nothing else is up, and close itself.
      if (e.key === '?' && (!modalOpen || s.helpOpen)) {
        e.preventDefault();
        s.setUi({ helpOpen: !s.helpOpen });
        return;
      }
      if (modalOpen) return; // don't fire graph shortcuts behind an open modal

      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('global-search')?.focus();
      } else if (e.key === 'f') {
        emit('fit');
      } else if (e.key === 'e') {
        useStore.setState((st) => ({ noteEditMode: !st.noteEditMode }));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <ErrorBoundary>
      <div className="flex h-screen flex-col bg-app text-ink-1">
        <TopBar />
        <div className="relative flex min-h-0 flex-1">
          <LeftRail />
          {/* Graph is a persistent full-size layer; the note panel overlays it on the right,
              so resizing/closing the panel reveals the already-rendered graph without a reflow. */}
          <main className="relative min-w-0 flex-1 overflow-hidden">
            <div className="absolute inset-0">
              <Graph />
            </div>
            <NotePanel />
          </main>
        </div>
        <ImportModal />
        <UsersModal />
        <SliverModal />
        <VaultBridgeModal />
        <NoteViewerModal />
        <ShortcutsModal />
        {toast && (
          <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-line bg-panel px-4 py-2 text-xs text-ink-1 shadow-xl">
            {toast}
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
}
