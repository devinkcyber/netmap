import { create } from 'zustand';
import type { Host, ScanMeta, UserCred } from './types';
import { osFamily, subnetOf } from './types';
import type { ColorBy } from './lib/encodings';
import { DEFAULT_BLOODHOUND_URL, LEGACY_BLOODHOUND_URL } from './lib/bloodhound';
import { isDomainControllerByPorts, setDcOverrides } from './lib/ad';
import type { SliverImplant, SliverStatus } from './lib/sliver';
import { loadJson, saveJson } from './lib/bus';
import * as credvault from './lib/credvault';

export type TopologyMode = 'trace' | 'subnet';
export type LayoutName = 'cose' | 'concentric' | 'breadthfirst';

export interface Filters {
  query: string;
  os: string | null; // OsFamily
  subnet: string | null;
  port: string; // number or service substring
  status: string | null; // note frontmatter status
  sliver: string | null; // live Sliver implant state: 'any' | 'session' | 'beacon' | 'none'
}

/** A host's live Sliver implant presence, threaded into hostMatchesFilters. */
export interface SliverPresence {
  session: boolean;
  beacon: boolean;
}

interface Settings {
  topologyMode: TopologyMode;
  layout: LayoutName;
  colorBy: ColorBy;
  mask: number;
  theme: 'dark' | 'light';
  hostsFolder: string;
  notePanelWidth: number;
  bloodhoundUrl: string; // Explore deep-link template; {q} = host name
  sliverUrl: string; // netmap-sliver-bridge base URL
  sliverToken: string; // bridge bearer token
  sliverEnabled: boolean; // auto-connect on load when true
  sliverAutoOwned: boolean; // opt-in: hosts with a live session show the owned ring (visual-only)
  vaultBridgeUrl: string; // netmap-vault-bridge base URL (non-Chromium vault access)
  vaultBridgeToken: string; // vault bridge bearer token
}

const SETTINGS_KEY = 'netmap:settings';
const SCAN_KEY = 'netmap:lastscan';
const LIGOLO_KEY = 'netmap:ligolo';
const LIGOLOTARGET_KEY = 'netmap:ligolotarget';
const DCOVERRIDE_KEY = 'netmap:dcoverride';
const SLIVERMATCH_KEY = 'netmap:slivermatch';

// A pivot can unlock several subnets. Older builds stored one CIDR string per pivot; normalize
// both shapes (and dedupe) so persisted state from either version loads as string[].
function loadLigoloTargets(): Record<string, string[]> {
  const raw = loadJson<Record<string, string | string[]>>(LIGOLOTARGET_KEY, {});
  const out: Record<string, string[]> = {};
  for (const [ip, v] of Object.entries(raw)) {
    const arr = (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean);
    if (arr.length) out[ip] = [...new Set(arr)];
  }
  return out;
}

const defaultSettings: Settings = {
  topologyMode: 'trace',
  layout: 'breadthfirst',
  colorBy: 'subnet',
  mask: 24,
  theme: 'dark',
  hostsFolder: 'Network/Hosts',
  notePanelWidth: 380,
  bloodhoundUrl: DEFAULT_BLOODHOUND_URL,
  sliverUrl: 'http://127.0.0.1:8888',
  sliverToken: '',
  sliverEnabled: false,
  sliverAutoOwned: false,
  vaultBridgeUrl: 'http://127.0.0.1:8899',
  vaultBridgeToken: '',
};

const defaultFilters: Filters = { query: '', os: null, subnet: null, port: '', status: null, sliver: null };

interface AppState extends Settings {
  hosts: Host[];
  scanMeta: ScanMeta | null;
  selectedId: string | null;
  filters: Filters;
  users: UserCred[];
  credProtected: boolean; // an encrypted credential blob exists in localStorage
  credLocked: boolean; // protected but no key held this session (list hidden until unlocked)
  ligoloByIp: Record<string, boolean>; // hosts flagged as running a Ligolo pivot agent
  ligoloTargetByIp: Record<string, string[]>; // pivot IP → the subnet CIDRs it unlocks access to
  dcOverrideByIp: Record<string, boolean>; // manual DC (true) / not-DC (false) overrides
  sliverStatus: SliverStatus;
  sliverImplants: SliverImplant[];
  sliverMatchOverride: Record<string, string>; // implant id → host IP (manual pin)
  importOpen: boolean;
  usersOpen: boolean;
  sliverOpen: boolean;
  vaultBridgeOpen: boolean;
  noteViewerOpen: boolean;
  helpOpen: boolean; // keyboard-shortcuts overlay
  noteEditorExpanded: boolean; // note editor blown up into a large near-fullscreen modal
  leftOpen: boolean;
  rightOpen: boolean;
  noteEditMode: boolean;
  vaultName: string | null;
  vaultCounts: { notes: number; matched: number } | null;
  noteStatusByIp: Record<string, string>;
  noteBhIdByIp: Record<string, string>;
  toast: string | null;

  setScan: (hosts: Host[], meta: ScanMeta | null, traceAvailable: boolean) => void;
  select: (id: string | null) => void;
  setFilters: (patch: Partial<Filters>) => void;
  setUsers: (users: UserCred[]) => void;
  enableCredProtection: (passphrase: string) => Promise<void>;
  unlockCreds: (passphrase: string) => Promise<void>;
  lockCreds: () => void;
  toggleLigolo: (ip: string) => void;
  toggleLigoloTarget: (ip: string, cidr: string) => void; // add/remove one unlocked subnet
  clearLigoloTargets: (ip: string) => void; // remove all unlocked subnets for a pivot
  toggleDcOverride: (ip: string) => void;
  setSliver: (patch: Partial<Pick<AppState, 'sliverStatus' | 'sliverImplants'>>) => void;
  setSliverMatch: (implantId: string, hostIp: string | null) => void;
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  setUi: (patch: Partial<Pick<AppState, 'importOpen' | 'usersOpen' | 'sliverOpen' | 'vaultBridgeOpen' | 'noteViewerOpen' | 'helpOpen' | 'noteEditorExpanded' | 'leftOpen' | 'rightOpen' | 'noteEditMode'>>) => void;
  setVault: (
    name: string | null,
    counts: { notes: number; matched: number } | null,
    statusByIp: Record<string, string>,
    bhIdByIp: Record<string, string>,
  ) => void;
  showToast: (msg: string) => void;
}

const savedSettings = loadJson<Settings>(SETTINGS_KEY, defaultSettings);
// Guard against settings persisted by older versions (e.g. colorBy: 'ports', sizeBy).
if (!['os', 'ad', 'domain', 'subnet'].includes(savedSettings.colorBy)) savedSettings.colorBy = defaultSettings.colorBy;
// Guard against layouts removed in a later version (e.g. 'grid', 'circle').
if (!['cose', 'concentric', 'breadthfirst'].includes(savedSettings.layout)) savedSettings.layout = defaultSettings.layout;
if (!Number.isFinite(savedSettings.notePanelWidth)) savedSettings.notePanelWidth = defaultSettings.notePanelWidth;
if (typeof savedSettings.bloodhoundUrl !== 'string' || !savedSettings.bloodhoundUrl) savedSettings.bloodhoundUrl = DEFAULT_BLOODHOUND_URL;
if (savedSettings.bloodhoundUrl === LEGACY_BLOODHOUND_URL) savedSettings.bloodhoundUrl = DEFAULT_BLOODHOUND_URL;
if (typeof savedSettings.sliverUrl !== 'string' || !savedSettings.sliverUrl) savedSettings.sliverUrl = defaultSettings.sliverUrl;
if (typeof savedSettings.sliverToken !== 'string') savedSettings.sliverToken = '';
if (typeof savedSettings.sliverEnabled !== 'boolean') savedSettings.sliverEnabled = false;
if (typeof savedSettings.sliverAutoOwned !== 'boolean') savedSettings.sliverAutoOwned = false;
if (typeof savedSettings.vaultBridgeUrl !== 'string' || !savedSettings.vaultBridgeUrl) savedSettings.vaultBridgeUrl = defaultSettings.vaultBridgeUrl;
if (typeof savedSettings.vaultBridgeToken !== 'string') savedSettings.vaultBridgeToken = '';
const savedScan = loadJson<{ hosts: Host[]; meta: ScanMeta | null } | null>(SCAN_KEY, null);

// Manual DC overrides live in ad.ts (so pure helpers respect them); seed it from storage.
const savedDcOverride = loadJson<Record<string, boolean>>(DCOVERRIDE_KEY, {});
setDcOverrides(savedDcOverride);

// The credential list is always encrypted at rest (see lib/credvault). If a
// passphrase has been set, start locked; otherwise the Users modal prompts the
// user to set one before they can add credentials. Either way the list starts empty.
const credProtectedInit = credvault.isProtected();

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<AppState>((set, get) => ({
  ...savedSettings,
  hosts: savedScan?.hosts ?? [],
  scanMeta: savedScan?.meta ?? null,
  selectedId: null,
  filters: { ...defaultFilters },
  users: [],
  credProtected: credProtectedInit, // a passphrase has been set (encrypted blob exists)
  credLocked: credProtectedInit, // needs unlocking this session
  ligoloByIp: loadJson<Record<string, boolean>>(LIGOLO_KEY, {}),
  ligoloTargetByIp: loadLigoloTargets(),
  dcOverrideByIp: savedDcOverride,
  sliverStatus: 'disconnected',
  sliverImplants: [],
  sliverMatchOverride: loadJson<Record<string, string>>(SLIVERMATCH_KEY, {}),
  importOpen: !savedScan?.hosts?.length,
  usersOpen: false,
  sliverOpen: false,
  vaultBridgeOpen: false,
  noteViewerOpen: false,
  helpOpen: false,
  noteEditorExpanded: false,
  leftOpen: true,
  rightOpen: true,
  noteEditMode: false,
  vaultName: null,
  vaultCounts: null,
  noteStatusByIp: {},
  noteBhIdByIp: {},
  toast: null,

  setScan: (hosts, meta, traceAvailable) => {
    const mode: TopologyMode = traceAvailable ? 'trace' : 'subnet';
    set({ hosts, scanMeta: meta, selectedId: null, importOpen: false, topologyMode: mode, filters: { ...defaultFilters } });
    persistSettings(get());
    try {
      const payload = JSON.stringify({ hosts, meta });
      if (payload.length < 4_000_000) saveJson(SCAN_KEY, { hosts, meta });
    } catch {
      /* ignore */
    }
  },

  select: (id) => set({ selectedId: id }),
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),

  setUsers: (users) => {
    set({ users });
    // The list is always encrypted at rest; persist only while unlocked.
    if (credvault.isUnlocked()) void credvault.saveEncrypted(users);
  },

  enableCredProtection: async (passphrase) => {
    await credvault.enableProtection(passphrase, get().users);
    set({ credProtected: true, credLocked: false });
  },

  unlockCreds: async (passphrase) => {
    const users = await credvault.unlock(passphrase); // throws on a wrong passphrase
    set({ users, credLocked: false });
  },

  lockCreds: () => {
    credvault.lock();
    set({ users: [], credLocked: true });
  },

  toggleLigolo: (ip) =>
    set((s) => {
      const next = { ...s.ligoloByIp };
      const targets = { ...s.ligoloTargetByIp };
      if (next[ip]) {
        delete next[ip];
        delete targets[ip]; // removing the pivot clears its unlocked-subnet link
      } else {
        next[ip] = true;
      }
      saveJson(LIGOLO_KEY, next);
      saveJson(LIGOLOTARGET_KEY, targets);
      return { ligoloByIp: next, ligoloTargetByIp: targets };
    }),

  toggleLigoloTarget: (ip, cidr) =>
    set((s) => {
      const targets = { ...s.ligoloTargetByIp };
      const cur = targets[ip] ?? [];
      const adding = !cur.includes(cidr);
      const next = adding ? [...cur, cidr] : cur.filter((c) => c !== cidr);
      if (next.length) targets[ip] = next;
      else delete targets[ip];
      saveJson(LIGOLOTARGET_KEY, targets);
      // Unlocking a subnet implies the host is a Ligolo pivot.
      const ligolo = adding && !s.ligoloByIp[ip] ? { ...s.ligoloByIp, [ip]: true } : s.ligoloByIp;
      if (ligolo !== s.ligoloByIp) saveJson(LIGOLO_KEY, ligolo);
      return { ligoloTargetByIp: targets, ligoloByIp: ligolo };
    }),

  clearLigoloTargets: (ip) =>
    set((s) => {
      const targets = { ...s.ligoloTargetByIp };
      delete targets[ip];
      saveJson(LIGOLOTARGET_KEY, targets);
      return { ligoloTargetByIp: targets };
    }),

  toggleDcOverride: (ip) =>
    set((s) => {
      const host = s.hosts.find((h) => h.ip === ip);
      const auto = host ? isDomainControllerByPorts(host) : false;
      const current = ip in s.dcOverrideByIp ? s.dcOverrideByIp[ip] : auto;
      const nextVal = !current;
      const next = { ...s.dcOverrideByIp };
      if (nextVal === auto) delete next[ip]; // matches the heuristic → revert to auto
      else next[ip] = nextVal;
      saveJson(DCOVERRIDE_KEY, next);
      setDcOverrides(next); // keep ad.ts in sync so isDomainController() reflects it
      return { dcOverrideByIp: next };
    }),

  setSliver: (patch) => set(patch),

  setSliverMatch: (implantId, hostIp) =>
    set((s) => {
      const next = { ...s.sliverMatchOverride };
      if (hostIp) next[implantId] = hostIp;
      else delete next[implantId];
      saveJson(SLIVERMATCH_KEY, next);
      return { sliverMatchOverride: next };
    }),

  setSetting: (key, value) => {
    set({ [key]: value } as Partial<AppState>);
    persistSettings(get());
  },

  setUi: (patch) => set(patch),

  setVault: (name, counts, statusByIp, bhIdByIp) =>
    set({ vaultName: name, vaultCounts: counts, noteStatusByIp: statusByIp, noteBhIdByIp: bhIdByIp }),

  showToast: (msg) => {
    set({ toast: msg });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 3200);
  },
}));

function persistSettings(s: AppState) {
  const { topologyMode, layout, colorBy, mask, theme, hostsFolder, notePanelWidth, bloodhoundUrl } = s;
  const { sliverUrl, sliverToken, sliverEnabled, sliverAutoOwned, vaultBridgeUrl, vaultBridgeToken } = s;
  saveJson(SETTINGS_KEY, {
    topologyMode, layout, colorBy, mask, theme, hostsFolder, notePanelWidth, bloodhoundUrl,
    sliverUrl, sliverToken, sliverEnabled, sliverAutoOwned, vaultBridgeUrl, vaultBridgeToken,
  });
}

// ---------- derived helpers ----------

export function subnetsOf(hosts: Host[], mask: number): string[] {
  return [...new Set(hosts.map((h) => subnetOf(h.ip, mask)))].sort();
}

export function hostMatchesFilters(
  h: Host,
  f: Filters,
  mask: number,
  statusByIp: Record<string, string>,
  sliver: SliverPresence = { session: false, beacon: false },
): boolean {
  if (f.os && osFamily(h.os) !== f.os) return false;
  if (f.subnet && subnetOf(h.ip, mask) !== f.subnet) return false;
  if (f.port.trim()) {
    // Comma-separated terms are OR'd: "80,443" matches hosts with 80 OR 443 open.
    // Each term matches an open port by exact number or by service-name substring.
    const terms = f.port.toLowerCase().split(',').map((t) => t.trim()).filter(Boolean);
    if (terms.length) {
      const hit = h.ports.some(
        (p) => p.state === 'open' && terms.some((q) => String(p.number) === q || (p.service ?? '').toLowerCase().includes(q)),
      );
      if (!hit) return false;
    }
  }
  if (f.status) {
    const st = statusByIp[h.ip] ?? 'no note';
    if (st !== f.status) return false;
  }
  if (f.sliver) {
    const has = sliver.session || sliver.beacon;
    if (f.sliver === 'session' && !sliver.session) return false;
    if (f.sliver === 'beacon' && !sliver.beacon) return false;
    if (f.sliver === 'any' && !has) return false;
    if (f.sliver === 'none' && has) return false;
  }
  if (f.query.trim()) {
    const q = f.query.trim().toLowerCase();
    const hay = [h.ip, ...h.hostnames, h.os ?? '', h.mac ?? '', h.vendor ?? '', ...h.ports.map((p) => p.service ?? '')]
      .join(' ')
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}
