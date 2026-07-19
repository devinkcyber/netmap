import type { Host } from '../types';
import { subnetOf } from '../types';

export type NodeKind = 'host' | 'router' | 'subnet' | 'net' | 'scanner';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  host?: Host; // present for kind === 'host'
  subnet?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  inferred?: boolean; // true when the link is a guess, not observed hop data
}

export interface Topology {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const SCANNER_ID = '__scanner__';
export const NET_ID = '__network__';

export function hasTraceroute(hosts: Host[]): boolean {
  return hosts.some((h) => h.hops && h.hops.length > 0);
}

/**
 * Traceroute view: chain each host's ordered hops from the scanner.
 * Hops that aren't scanned hosts become router nodes; edges are deduped so
 * shared path prefixes merge into a real tree.
 */
export function buildTraceTopology(hosts: Host[], mask: number): Topology {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  nodes.set(SCANNER_ID, { id: SCANNER_ID, kind: 'scanner', label: 'scanner (you)' });
  for (const h of hosts) {
    nodes.set(h.ip, { id: h.ip, kind: 'host', label: h.hostnames[0] ?? h.ip, host: h, subnet: subnetOf(h.ip, mask) });
  }

  const addEdge = (a: string, b: string, inferred = false) => {
    if (a === b) return;
    const id = a < b ? `${a}--${b}` : `${b}--${a}`;
    const existing = edges.get(id);
    if (existing) {
      if (existing.inferred && !inferred) existing.inferred = false; // observed beats inferred
      return;
    }
    edges.set(id, { id, source: a, target: b, inferred });
  };

  for (const h of hosts) {
    if (!h.hops || h.hops.length === 0) {
      // No path data for this host — attach to the scanner with a dashed edge.
      addEdge(SCANNER_ID, h.ip, true);
      continue;
    }
    let prev = SCANNER_ID;
    for (const hop of h.hops) {
      if (!nodes.has(hop)) {
        nodes.set(hop, { id: hop, kind: 'router', label: hop, subnet: subnetOf(hop, mask) });
      }
      addEdge(prev, hop);
      prev = hop;
    }
    if (prev !== h.ip) addEdge(prev, h.ip); // last hop usually *is* the target; guard when it isn't
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/**
 * Subnet-grouped view: a synthetic node per inferred subnet, hosts hang off
 * their subnet, and subnets join a central network node when there's more than one.
 */
export function buildSubnetTopology(hosts: Host[], mask: number): Topology {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const subnets = new Map<string, string[]>();

  for (const h of hosts) {
    const sn = subnetOf(h.ip, mask);
    nodes.set(h.ip, { id: h.ip, kind: 'host', label: h.hostnames[0] ?? h.ip, host: h, subnet: sn });
    (subnets.get(sn) ?? subnets.set(sn, []).get(sn)!).push(h.ip);
  }

  for (const [sn, members] of subnets) {
    const snId = `subnet:${sn}`;
    nodes.set(snId, { id: snId, kind: 'subnet', label: sn, subnet: sn });
    for (const ip of members) edges.push({ id: `${snId}--${ip}`, source: snId, target: ip, inferred: true });
  }

  if (subnets.size > 1) {
    nodes.set(NET_ID, { id: NET_ID, kind: 'net', label: 'network' });
    for (const sn of subnets.keys()) {
      edges.push({ id: `${NET_ID}--subnet:${sn}`, source: NET_ID, target: `subnet:${sn}`, inferred: true });
    }
  }

  return { nodes: [...nodes.values()], edges };
}

export function buildTopology(hosts: Host[], mode: 'trace' | 'subnet', mask: number): Topology {
  return mode === 'trace' ? buildTraceTopology(hosts, mask) : buildSubnetTopology(hosts, mask);
}

/** Stable key for a scan, used to persist dragged node positions per scan+view. */
export function scanKey(hosts: Host[], mode: string, mask: number): string {
  const ids = hosts.map((h) => h.ip).sort().join(',');
  let hash = 0;
  for (let i = 0; i < ids.length; i++) hash = (hash * 31 + ids.charCodeAt(i)) | 0;
  return `netmap:pos:${mode}:${mask}:${(hash >>> 0).toString(36)}`;
}
