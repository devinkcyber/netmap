import type { Host } from '../types';
import { openPorts, osFamily } from '../types';

/**
 * Active Directory heuristics, derived purely from open ports + OS detection.
 * Nothing here talks to a domain — it's all inference from an nmap scan.
 */

export type AdRole = 'Domain Controller' | 'AD Member' | 'Non-AD';

/** Open ports that are meaningful in an AD environment, with friendly labels. */
export const AD_PORTS: Record<number, string> = {
  53: 'DNS',
  88: 'Kerberos',
  135: 'RPC',
  139: 'NetBIOS',
  389: 'LDAP',
  445: 'SMB',
  464: 'kpasswd',
  636: 'LDAPS',
  3268: 'Global Catalog',
  3269: 'Global Catalog (SSL)',
  5985: 'WinRM',
  5986: 'WinRM (SSL)',
  9389: 'AD Web Services',
};

function openSet(h: Host): Set<number> {
  return new Set(openPorts(h).map((p) => p.number));
}

/**
 * A host is treated as a Domain Controller from its exposed AD DS services:
 *  - a Global Catalog (3268/3269) is near-certain on its own;
 *  - otherwise Kerberos (88) — the DC/KDC hallmark — paired with any other AD
 *    service (SMB, LDAP, kpasswd, RPC, or DNS). Requiring LDAP too is too strict:
 *    real scans routinely capture 88 + 445/53 but miss 389, and a KDC on a
 *    Windows/AD host is a DC.
 */
export function isDomainControllerByPorts(h: Host): boolean {
  const open = openSet(h);
  if (open.has(3268) || open.has(3269)) return true;
  if (open.has(88) && (open.has(445) || open.has(389) || open.has(464) || open.has(135) || open.has(53))) return true;
  return false;
}

// Manual per-host DC overrides (keyed by IP): true = force DC, false = force not-DC.
// Kept as module state so every isDomainController() caller respects it without
// threading the map through pure functions. The store owns it and mirrors it here.
let dcOverrides: Record<string, boolean> = {};
export function setDcOverrides(map: Record<string, boolean>): void {
  dcOverrides = map;
}

/** Effective DC status: a manual override wins over the port heuristic. */
export function isDomainController(h: Host): boolean {
  if (h.ip in dcOverrides) return dcOverrides[h.ip];
  return isDomainControllerByPorts(h);
}

export function adRole(h: Host): AdRole {
  if (isDomainController(h)) return 'Domain Controller';
  // Windows hosts (or anything speaking SMB/Kerberos) that aren't DCs are
  // treated as domain members for the purposes of an AD-centric view.
  const open = openSet(h);
  if (osFamily(h.os) === 'Windows' || open.has(445) || open.has(88)) return 'AD Member';
  return 'Non-AD';
}

/**
 * The host's AD/DNS domain — everything after the first label of its FQDN.
 * e.g. ZPH-SVRDC01.zsm.local → "zsm.local"; host.internal.zsm.local →
 * "internal.zsm.local" (so a child domain reads distinctly from its parent).
 */
export function adDomain(h: Host): string {
  const fqdn = h.hostnames[0];
  if (!fqdn) return '';
  const dot = fqdn.indexOf('.');
  return dot >= 0 ? fqdn.slice(dot + 1).toLowerCase() : '';
}

/** Distinct AD domains present in a set of hosts, sorted. */
export function domainsOf(hosts: Host[]): string[] {
  return [...new Set(hosts.map(adDomain).filter(Boolean))].sort();
}

/** Friendly names of the AD-relevant services this host currently exposes. */
export function adServices(h: Host): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of openPorts(h)) {
    const label = AD_PORTS[p.number];
    if (label && !seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}
