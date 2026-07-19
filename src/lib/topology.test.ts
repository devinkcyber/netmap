import { describe, it, expect } from 'vitest';
import { buildTraceTopology, buildSubnetTopology, hasTraceroute, SCANNER_ID, NET_ID } from './topology';
import type { Host } from '../types';

function host(ip: string, hops?: string[]): Host {
  return { id: ip, ip, hostnames: [], state: 'up', ports: [], hops };
}

describe('hasTraceroute', () => {
  it('is true only when a host carries hop data', () => {
    expect(hasTraceroute([host('10.0.0.5', ['10.0.0.1', '10.0.0.5'])])).toBe(true);
    expect(hasTraceroute([host('10.0.0.5')])).toBe(false);
  });
});

describe('buildTraceTopology', () => {
  it('chains hops from the scanner and merges shared prefixes into a tree', () => {
    const hosts = [host('10.0.0.5', ['10.0.0.1', '10.0.0.5']), host('10.0.0.6', ['10.0.0.1', '10.0.0.6'])];
    const { nodes, edges } = buildTraceTopology(hosts, 24);

    const ids = nodes.map((n) => n.id);
    expect(ids).toContain(SCANNER_ID);
    expect(ids).toContain('10.0.0.1');

    // the shared router hop yields exactly one scanner→router edge, not two
    const scannerToRouter = edges.filter(
      (e) =>
        (e.source === SCANNER_ID && e.target === '10.0.0.1') ||
        (e.source === '10.0.0.1' && e.target === SCANNER_ID),
    );
    expect(scannerToRouter).toHaveLength(1);

    // an unscanned hop is a router node; a scanned host is a host node
    expect(nodes.find((n) => n.id === '10.0.0.1')?.kind).toBe('router');
    expect(nodes.find((n) => n.id === '10.0.0.5')?.kind).toBe('host');
  });

  it('attaches a host with no hop data to the scanner via an inferred edge', () => {
    const { edges } = buildTraceTopology([host('10.0.0.9')], 24);
    const e = edges.find((edge) => edge.source === SCANNER_ID && edge.target === '10.0.0.9');
    expect(e?.inferred).toBe(true);
  });
});

describe('buildSubnetTopology', () => {
  it('groups hosts under synthetic subnet nodes joined by a network hub', () => {
    const hosts = [host('10.0.0.5'), host('10.0.0.6'), host('10.0.1.5')];
    const { nodes, edges } = buildSubnetTopology(hosts, 24);

    expect(nodes.find((n) => n.id === 'subnet:10.0.0.0/24')?.kind).toBe('subnet');
    expect(nodes.find((n) => n.id === 'subnet:10.0.1.0/24')?.kind).toBe('subnet');
    expect(nodes.find((n) => n.id === NET_ID)).toBeTruthy(); // >1 subnet → network hub
    expect(edges.some((e) => e.source === 'subnet:10.0.0.0/24' && e.target === '10.0.0.5')).toBe(true);
  });

  it('omits the network hub when there is a single subnet', () => {
    const { nodes } = buildSubnetTopology([host('10.0.0.5'), host('10.0.0.6')], 24);
    expect(nodes.find((n) => n.id === NET_ID)).toBeFalsy();
  });
});
