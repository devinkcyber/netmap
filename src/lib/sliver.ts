import { useStore } from '../store';
import type { Host } from '../types';

/**
 * Sliver C2 client for netmap. Talks to the local `netmap-sliver-bridge` over a
 * WebSocket (`/events`). The bridge pushes an authoritative snapshot on connect
 * and again on every session/beacon change, so we just consume snapshots — no
 * polling, and no need to decode Sliver's untyped beacon events.
 */

export type SliverStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SliverImplant {
  id: string;
  kind: 'session' | 'beacon';
  name: string;
  hostname: string;
  username: string;
  os: string;
  arch: string;
  transport: string;
  remoteAddress: string;
  pid: number;
  version: string;
  integrity: string;
  isDead: boolean;
  lastCheckin: number; // unix seconds
  interval?: number; // seconds (beacons)
  jitter?: number; // seconds (beacons)
  nextCheckin?: number; // unix seconds (beacons)
}

// Sliver's protobuf JSON renders int64 fields as strings, so coerce carefully.
type Raw = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseInt(str(v), 10);
  return Number.isFinite(n) ? n : 0;
};

function normalize(raw: Raw, kind: 'session' | 'beacon'): SliverImplant {
  const im: SliverImplant = {
    id: str(raw.ID),
    kind,
    name: str(raw.Name),
    hostname: str(raw.Hostname),
    username: str(raw.Username),
    os: str(raw.OS),
    arch: str(raw.Arch),
    transport: str(raw.Transport),
    remoteAddress: str(raw.RemoteAddress),
    pid: num(raw.PID),
    version: str(raw.Version),
    integrity: str(raw.Integrity),
    isDead: raw.IsDead === true,
    lastCheckin: num(raw.LastCheckin),
  };
  if (kind === 'beacon') {
    im.interval = Math.round(num(raw.Interval) / 1e9); // ns → s
    im.jitter = Math.round(num(raw.Jitter) / 1e9); // ns → s
    im.nextCheckin = num(raw.NextCheckin);
  }
  return im;
}

/** Human-friendly "time since" for a unix-seconds timestamp. */
export function sinceLabel(unixSec: number): string {
  if (!unixSec) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Strip a trailing `:port` from a Sliver RemoteAddress, leaving the IP. */
function addrIp(remoteAddress: string): string {
  return remoteAddress.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}

/**
 * Implants that belong to a scanned host. An implant explicitly pinned to a host
 * (via `override`: implantId → host IP) matches only that host; everything else
 * auto-matches by Sliver hostname (full or short) or by the implant's
 * RemoteAddress IP against the host's IP/hostnames.
 */
export function implantsForHost(host: Host, implants: SliverImplant[], override: Record<string, string> = {}): SliverImplant[] {
  const targets = new Set<string>();
  targets.add(host.ip.toLowerCase());
  for (const hn of host.hostnames) {
    const h = hn.toLowerCase();
    targets.add(h);
    targets.add(h.split('.')[0]);
  }
  return implants.filter((im) => {
    const pinned = override[im.id];
    if (pinned) return pinned === host.ip;
    const hn = im.hostname.toLowerCase();
    const short = hn.split('.')[0];
    const ip = addrIp(im.remoteAddress);
    return (!!hn && (targets.has(hn) || targets.has(short))) || (!!ip && targets.has(ip));
  });
}

/**
 * Progress of a beacon toward its next check-in, phased on `lastCheckin` and its
 * `interval` (so it re-syncs whenever a real check-in updates the snapshot).
 * Returns interval 0 for sessions / beacons without interval info.
 */
export function beaconProgress(im: SliverImplant): { progress: number; remaining: number; interval: number } {
  const interval = im.interval && im.interval > 0 ? im.interval : 0;
  if (interval <= 0) return { progress: 0, remaining: 0, interval: 0 };
  const now = Date.now() / 1000;
  const anchor = im.lastCheckin || (im.nextCheckin ? im.nextCheckin - interval : now);
  const elapsed = (((now - anchor) % interval) + interval) % interval; // 0..interval
  return { progress: elapsed / interval, remaining: interval - elapsed, interval };
}

/**
 * Populate a demo session + beacon without a Sliver server, so the C2 overlay
 * (session/beacon rings, the animated beacon countdown + timer, and the Sliver
 * filters) can be exercised for testing/demos. The implants are matched to hosts
 * in the current scan by RemoteAddress IP, put on two different hosts so the
 * beacon ring shows (a session on the same host would suppress it). Not persisted
 * — cleared on reload, or via "Clear demo implants".
 */
export function loadSampleImplants(): void {
  const s = useStore.getState();
  const hosts = s.hosts;
  if (hosts.length === 0) {
    s.showToast('Load a scan first, then add demo implants.');
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const nameOf = (h: Host) => h.hostnames[0] ?? h.ip;
  const beaconHost = hosts.find((h) => h.hostnames.length > 0) ?? hosts[0];
  const sessionHost = hosts.find((h) => h.ip !== beaconHost.ip) ?? beaconHost;
  const implants: SliverImplant[] = [
    {
      id: 'demo-beacon',
      kind: 'beacon',
      name: 'DEMO_BEACON',
      hostname: nameOf(beaconHost),
      username: 'CORP\\svc_sql',
      os: 'windows',
      arch: 'amd64',
      transport: 'https',
      remoteAddress: `${beaconHost.ip}:44113`,
      pid: 8324,
      version: '',
      integrity: 'High',
      isDead: false,
      lastCheckin: now - 6,
      interval: 60,
      jitter: 8,
      nextCheckin: now + 54,
    },
  ];
  if (sessionHost.ip !== beaconHost.ip) {
    implants.push({
      id: 'demo-session',
      kind: 'session',
      name: 'DEMO_SESSION',
      hostname: nameOf(sessionHost),
      username: 'NT AUTHORITY\\SYSTEM',
      os: 'windows',
      arch: 'amd64',
      transport: 'mtls',
      remoteAddress: `${sessionHost.ip}:51820`,
      pid: 4120,
      version: '',
      integrity: 'System',
      isDead: false,
      lastCheckin: now - 3,
    });
  }
  s.setSliver({ sliverImplants: implants });
  s.showToast(`Loaded demo Sliver implants (${implants.length === 2 ? '1 beacon, 1 session' : '1 beacon'}).`);
}

// ---------- connection ----------

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let backoff = 1000;
let manualClose = false;

function toWsUrl(base: string): string {
  let u = base.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(u)) u = u.replace(/^http/i, 'ws');
  else if (!/^wss?:\/\//i.test(u)) u = 'ws://' + u;
  if (!/\/events$/.test(u)) u += '/events';
  return u;
}

/** Connect (and remember the settings so we auto-connect next load). */
export function connectSliver(url: string, token: string): void {
  const s = useStore.getState();
  s.setSetting('sliverUrl', url);
  s.setSetting('sliverToken', token);
  s.setSetting('sliverEnabled', true);
  manualClose = false;
  openSocket(url, token);
}

/** Reconnect using whatever is already saved (used on app load). */
export function restoreSliver(): void {
  const s = useStore.getState();
  if (s.sliverEnabled && s.sliverUrl && s.sliverToken) {
    manualClose = false;
    openSocket(s.sliverUrl, s.sliverToken);
  }
}

export function disconnectSliver(): void {
  manualClose = true;
  clearTimeout(reconnectTimer);
  useStore.getState().setSetting('sliverEnabled', false);
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
  useStore.getState().setSliver({ sliverStatus: 'disconnected', sliverImplants: [] });
}

function openSocket(url: string, token: string): void {
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
  useStore.getState().setSliver({ sliverStatus: 'connecting' });

  let sock: WebSocket;
  try {
    sock = new WebSocket(`${toWsUrl(url)}?token=${encodeURIComponent(token)}`);
  } catch {
    useStore.getState().setSliver({ sliverStatus: 'error' });
    scheduleReconnect(url, token);
    return;
  }
  ws = sock;

  sock.onopen = () => {
    backoff = 1000;
    useStore.getState().setSliver({ sliverStatus: 'connected' });
  };
  sock.onmessage = (ev) => handleMessage(String(ev.data));
  sock.onclose = () => {
    if (ws === sock) ws = null;
    if (manualClose) {
      useStore.getState().setSliver({ sliverStatus: 'disconnected' });
      return;
    }
    useStore.getState().setSliver({ sliverStatus: 'error' });
    scheduleReconnect(url, token);
  };
  sock.onerror = () => {
    /* onclose fires next; reconnect handled there */
  };
}

function scheduleReconnect(url: string, token: string): void {
  if (manualClose) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => openSocket(url, token), backoff);
  backoff = Math.min(backoff * 2, 30000);
}

function handleMessage(data: string): void {
  let msg: { kind?: string; sessions?: { Sessions?: Raw[] }; beacons?: { Beacons?: Raw[] }; event?: Raw };
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (msg.kind === 'snapshot') {
    const sessions = (msg.sessions?.Sessions ?? []).map((s) => normalize(s, 'session'));
    const beacons = (msg.beacons?.Beacons ?? []).map((b) => normalize(b, 'beacon'));
    useStore.getState().setSliver({ sliverImplants: [...sessions, ...beacons] });
  } else if (msg.kind === 'event') {
    const type = str(msg.event?.EventType);
    const session = msg.event?.Session as Raw | undefined;
    const who = session ? str(session.Hostname) || str(session.Name) : '';
    if (type === 'session-connected') useStore.getState().showToast(`Sliver session connected${who ? `: ${who}` : ''}`);
    else if (type === 'session-disconnected') useStore.getState().showToast(`Sliver session disconnected${who ? `: ${who}` : ''}`);
    else if (type === 'beacon-registered') useStore.getState().showToast('Sliver beacon registered');
  }
}
