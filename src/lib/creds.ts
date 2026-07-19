import type { Host, UserCred } from '../types';

/**
 * Credentials whose `host` target matches this host — by IP, by any full
 * hostname, or by the short (pre-dot) name. Matching is case-insensitive.
 */
export function credsForHost(host: Host, users: UserCred[]): UserCred[] {
  const targets = new Set<string>();
  targets.add(host.ip.toLowerCase());
  for (const hn of host.hostnames) {
    const h = hn.toLowerCase();
    targets.add(h);
    targets.add(h.split('.')[0]); // short name
  }
  return users.filter((u) => {
    const t = u.host?.trim().toLowerCase();
    return !!t && targets.has(t);
  });
}

/** IPs of all hosts that have at least one credential targeted at them. */
export function hostsWithCreds(hosts: Host[], users: UserCred[]): Set<string> {
  const withHost = users.filter((u) => u.host && u.host.trim());
  const out = new Set<string>();
  if (withHost.length === 0) return out;
  for (const h of hosts) if (credsForHost(h, withHost).length > 0) out.add(h.ip);
  return out;
}
