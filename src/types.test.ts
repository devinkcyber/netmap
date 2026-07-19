import { describe, it, expect } from 'vitest';
import { subnetOf, osFamily, displayName, openPorts } from './types';
import type { Host } from './types';

describe('subnetOf', () => {
  it('masks IPv4 addresses to their network address', () => {
    expect(subnetOf('10.0.5.9', 24)).toBe('10.0.5.0/24');
    expect(subnetOf('192.168.1.130', 25)).toBe('192.168.1.128/25');
    expect(subnetOf('172.16.40.7', 16)).toBe('172.16.0.0/16');
    expect(subnetOf('10.20.30.40', 8)).toBe('10.0.0.0/8');
  });

  it('buckets non-IPv4 input as "other"', () => {
    expect(subnetOf('not-an-ip', 24)).toBe('other');
    expect(subnetOf('fe80::1', 24)).toBe('other');
  });
});

describe('osFamily', () => {
  it('classifies OS strings into families', () => {
    expect(osFamily('Microsoft Windows Server 2019')).toBe('Windows');
    expect(osFamily('Linux 5.4')).toBe('Linux');
    expect(osFamily('FreeBSD 13')).toBe('BSD');
    expect(osFamily('Cisco IOS 15')).toBe('Network gear');
    expect(osFamily('Some Appliance OS')).toBe('Other');
    expect(osFamily(undefined)).toBe('Unknown');
  });
});

describe('host helpers', () => {
  const h: Host = {
    id: '10.0.0.5',
    ip: '10.0.0.5',
    hostnames: ['dc01.zsm.local'],
    state: 'up',
    ports: [
      { number: 88, protocol: 'tcp', state: 'open' },
      { number: 9999, protocol: 'tcp', state: 'closed' },
    ],
  };

  it('displayName prefers the first hostname, falling back to the IP', () => {
    expect(displayName(h)).toBe('dc01.zsm.local');
    expect(displayName({ ...h, hostnames: [] })).toBe('10.0.0.5');
  });

  it('openPorts returns only open ports', () => {
    expect(openPorts(h).map((p) => p.number)).toEqual([88]);
  });
});
