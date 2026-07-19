import { parseNmapXml } from './parseNmap';
import { hasTraceroute } from './topology';
import { useStore } from '../store';
import type { SliverImplant } from './sliver';

/**
 * One-time demo seeding for the hosted GitHub Pages build (VITE_DEMO=1). A first
 * visitor lands on a fully staged engagement instead of the import prompt: the
 * bundled sample scan is auto-loaded, a Ligolo pivot on a corp workstation has
 * unlocked the secure enclave, and a spread of live Sliver sessions/beacons is
 * overlaid on real hosts.
 *
 * Guarded by the demo flag, so ordinary dev/prod builds never auto-load anything.
 * The sample scan is only loaded when no scan is present, so a visitor's own
 * imported scan is never clobbered.
 */

const PIVOT_IP = '10.30.20.60'; // ws-admin.corp.lan
const UNLOCKED_SUBNET = '10.31.0.0/24'; // secure enclave (dc-sec / pki / vault), at the default /24 mask

/** A staged post-exploitation picture: a DMZ foothold, lateral hops, a pivot, and an owned DC. */
function demoImplants(): SliverImplant[] {
  const now = Math.floor(Date.now() / 1000);
  return [
    // Ligolo pivot host — SYSTEM session that ties the unlocked-enclave story together.
    { id: 'demo-ws-admin', kind: 'session', name: 'JOLLY_PIVOT', hostname: 'ws-admin.corp.lan', username: 'NT AUTHORITY\\SYSTEM', os: 'windows', arch: 'amd64', transport: 'mtls', remoteAddress: '10.30.20.60:51820', pid: 4120, version: '', integrity: 'System', isDead: false, lastCheckin: now - 4 },
    // Owned domain controller — interactive session.
    { id: 'demo-dc01', kind: 'session', name: 'AMBER_KEEP', hostname: 'dc01.corp.lan', username: 'CORP\\Administrator', os: 'windows', arch: 'amd64', transport: 'mtls', remoteAddress: '10.30.10.5:51821', pid: 680, version: '', integrity: 'System', isDead: false, lastCheckin: now - 9 },
    // Service-account beacon on the SQL host.
    { id: 'demo-sql01', kind: 'beacon', name: 'QUIET_FALCON', hostname: 'sql01.corp.lan', username: 'CORP\\svc_sql', os: 'windows', arch: 'amd64', transport: 'https', remoteAddress: '10.30.10.15:44113', pid: 8324, version: '', integrity: 'High', isDead: false, lastCheckin: now - 12, interval: 60, jitter: 10, nextCheckin: now + 48 },
    // Fast-checking beacon (5s interval) — its countdown ring sweeps a full loop
    // every few seconds, so a short screen recording captures the whole animation.
    { id: 'demo-exch01', kind: 'beacon', name: 'SWIFT_EMBER', hostname: 'exch01.corp.lan', username: 'CORP\\svc_exchange', os: 'windows', arch: 'amd64', transport: 'https', remoteAddress: '10.30.10.20:44116', pid: 6612, version: '', integrity: 'High', isDead: false, lastCheckin: now - 1, interval: 5, jitter: 1, nextCheckin: now + 4 },
    // Lateral hop through the mgmt jumpbox.
    { id: 'demo-jump', kind: 'beacon', name: 'RUSTY_ANCHOR', hostname: 'jumpbox.mgmt.lan', username: 'root', os: 'linux', arch: 'amd64', transport: 'https', remoteAddress: '10.10.0.10:44114', pid: 2231, version: '', integrity: '', isDead: false, lastCheckin: now - 30, interval: 120, jitter: 20, nextCheckin: now + 90 },
    // Initial DMZ foothold.
    { id: 'demo-web01', kind: 'beacon', name: 'PALE_TIDE', hostname: 'web01.dmz.example.com', username: 'www-data', os: 'linux', arch: 'amd64', transport: 'http', remoteAddress: '10.20.10.10:44115', pid: 1544, version: '', integrity: '', isDead: false, lastCheckin: now - 70, interval: 300, jitter: 45, nextCheckin: now + 230 },
  ];
}

async function loadSampleScan(): Promise<boolean> {
  const res = await fetch(`${import.meta.env.BASE_URL}sample-scan.xml`);
  if (!res.ok) return false;
  const { hosts, meta } = parseNmapXml(await res.text());
  if (!hosts.length) return false;
  useStore.getState().setScan(hosts, meta, hasTraceroute(hosts));
  return true;
}

/** Flag the pivot and link the unlocked subnet (toggleLigoloTarget also sets the pivot flag). */
function seedLigolo(): void {
  const s = useStore.getState();
  if (!(s.ligoloTargetByIp[PIVOT_IP] ?? []).includes(UNLOCKED_SUBNET)) {
    s.toggleLigoloTarget(PIVOT_IP, UNLOCKED_SUBNET);
  }
}

/** Implants aren't persisted, so re-seed them on each demo load — unless a real bridge is in play. */
function seedImplants(): void {
  const s = useStore.getState();
  if (s.sliverStatus !== 'disconnected' || s.sliverImplants.length) return;
  s.setSliver({ sliverImplants: demoImplants() });
}

export async function seedDemoIfEnabled(): Promise<void> {
  if (!import.meta.env.VITE_DEMO) return;
  const s = useStore.getState();
  if (s.hosts.length === 0) {
    // First visit: load the sample and stage the pivot. On failure, fall back to the import prompt.
    if (!(await loadSampleScan())) {
      s.setUi({ importOpen: true });
      return;
    }
    seedLigolo();
  }
  seedImplants();
}
