import type { Host, OsFamily } from '../types';
import { osFamily } from '../types';
import { adDomain, adRole, isDomainController, type AdRole } from './ad';

export type ColorBy = 'os' | 'ad' | 'domain' | 'subnet';

export const OS_COLORS: Record<OsFamily, string> = {
  Windows: '#2b86f0',
  Linux: '#f5b400',
  BSD: '#ff5c5c',
  'Network gear': '#1fcf80',
  Other: '#93a3b5',
  Unknown: '#66707d',
};

export const AD_COLORS: Record<AdRole, string> = {
  'Domain Controller': '#f5b400',
  'AD Member': '#2b86f0',
  'Non-AD': '#66707d',
};

// Categorical palette for subnets (cycles) — saturated, well-separated hues
export const SUBNET_COLORS = ['#3aa0ff', '#f5b400', '#1fcf80', '#b06bff', '#ff5c5c', '#ff8f3a', '#25d3c0', '#c9d032'];

// Categorical palette for AD domains (cycles) — distinct hues so parent/child domains read apart
export const DOMAIN_COLORS = ['#3aa0ff', '#ff7a33', '#9d6bff', '#1fcf80', '#ff5c9d', '#f5c400', '#25c8d3', '#ff5c5c'];

/** Ring color drawn on a node for its note's triage status. */
export const STATUS_COLORS: Record<string, string> = {
  unreviewed: '#ffffff',
  reviewed: '#25d366',
  owned: '#c774ff',
};

export function statusColor(status: string | undefined): string | undefined {
  return status ? STATUS_COLORS[status] ?? '#ffa733' : undefined;
}

export function colorForHost(
  h: Host,
  colorBy: ColorBy,
  subnetIndex: Map<string, number>,
  subnet: string | undefined,
  domainIndex: Map<string, number>,
): string {
  switch (colorBy) {
    case 'os':
      return OS_COLORS[osFamily(h.os)];
    case 'ad':
      return AD_COLORS[adRole(h)];
    case 'domain': {
      const d = adDomain(h);
      if (!d) return '#5b6572'; // no FQDN → no known domain
      const i = domainIndex.get(d) ?? 0;
      return DOMAIN_COLORS[i % DOMAIN_COLORS.length];
    }
    case 'subnet': {
      const i = subnet !== undefined ? subnetIndex.get(subnet) ?? 0 : 0;
      return SUBNET_COLORS[i % SUBNET_COLORS.length];
    }
  }
}

/** Domain Controllers are drawn larger than everything else. */
export function sizeForHost(h: Host): number {
  return isDomainController(h) ? 54 : 34;
}
