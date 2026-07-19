export interface Port {
  number: number;
  protocol: 'tcp' | 'udp';
  state: string; // open | filtered | closed | ...
  service?: string;
  product?: string;
  version?: string;
}

export interface Host {
  id: string; // stable key — the primary IP
  ip: string;
  hostnames: string[];
  mac?: string;
  vendor?: string;
  os?: string; // highest-accuracy osmatch, if OS detection ran
  osAccuracy?: number;
  state: 'up' | 'down';
  ports: Port[];
  hops?: string[]; // ordered traceroute hop IPs (scanner → target), if --traceroute ran
  lastSeen?: string; // ISO date
}

/** One row of the AD user/credential list (usernames from user.txt + assigned plaintext passwords). */
export interface UserCred {
  username: string;
  password: string;
  host?: string; // optional target this credential applies to (IP or hostname), ties it to a node
}

export interface ScanMeta {
  args?: string;
  startstr?: string;
  scanner?: string;
  version?: string;
}

export interface ParsedScan {
  hosts: Host[];
  meta: ScanMeta;
  warnings: string[];
}

export function openPorts(h: Host): Port[] {
  return h.ports.filter((p) => p.state === 'open');
}

export function displayName(h: Host): string {
  return h.hostnames[0] ?? h.ip;
}

export type OsFamily =
  | 'Windows'
  | 'Linux'
  | 'BSD'
  | 'Network gear'
  | 'Other'
  | 'Unknown';

export function osFamily(os?: string): OsFamily {
  if (!os) return 'Unknown';
  const s = os.toLowerCase();
  if (s.includes('windows')) return 'Windows';
  if (s.includes('linux') || s.includes('android')) return 'Linux';
  if (s.includes('bsd')) return 'BSD';
  if (s.includes('cisco') || s.includes('juniper') || s.includes('routeros') || s.includes('router') || s.includes('switch') || s.includes('fortinet') || s.includes('pfsense')) return 'Network gear';
  return 'Other';
}

/** Network address of `ip` under a /mask prefix, e.g. subnetOf('10.0.5.9', 24) → '10.0.5.0/24'. */
export function subnetOf(ip: string, mask: number): string {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return 'other';
  const addr = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const m = mask === 0 ? 0 : (0xffffffff << (32 - mask)) >>> 0;
  const net = (addr & m) >>> 0;
  return `${(net >>> 24) & 255}.${(net >>> 16) & 255}.${(net >>> 8) & 255}.${net & 255}/${mask}`;
}
