import { describe, it, expect } from 'vitest';
import { isDomainControllerByPorts, adRole, adServices, adDomain } from './ad';
import type { Host, Port } from '../types';

function host(p: { ip: string; ports: Port[]; hostnames?: string[]; os?: string }): Host {
  return { id: p.ip, ip: p.ip, hostnames: p.hostnames ?? [], os: p.os, state: 'up', ports: p.ports };
}

const openTcp = (n: number): Port => ({ number: n, protocol: 'tcp', state: 'open' });

describe('AD heuristics', () => {
  it('flags a Global Catalog host as a domain controller', () => {
    const h = host({ ip: '10.0.0.5', ports: [openTcp(3268)] });
    expect(isDomainControllerByPorts(h)).toBe(true);
  });

  it('flags Kerberos + SMB as a domain controller', () => {
    const h = host({ ip: '10.0.0.5', ports: [openTcp(88), openTcp(445)] });
    expect(isDomainControllerByPorts(h)).toBe(true);
    expect(adRole(h)).toBe('Domain Controller');
  });

  it('does not flag Kerberos alone', () => {
    const h = host({ ip: '10.0.0.5', ports: [openTcp(88)] });
    expect(isDomainControllerByPorts(h)).toBe(false);
  });

  it('treats an SMB-only Windows host as an AD member, not a DC', () => {
    const h = host({ ip: '10.0.0.6', os: 'Microsoft Windows Server 2019', ports: [openTcp(445)] });
    expect(isDomainControllerByPorts(h)).toBe(false);
    expect(adRole(h)).toBe('AD Member');
  });

  it('labels the exposed AD services', () => {
    const h = host({ ip: '10.0.0.5', ports: [openTcp(88), openTcp(445), openTcp(389)] });
    expect(adServices(h)).toEqual(expect.arrayContaining(['Kerberos', 'SMB', 'LDAP']));
  });

  it('derives the domain from the FQDN, keeping child domains distinct', () => {
    expect(adDomain(host({ ip: '10.0.0.5', hostnames: ['dc01.zsm.local'], ports: [] }))).toBe('zsm.local');
    expect(adDomain(host({ ip: '10.0.0.7', hostnames: ['host.internal.zsm.local'], ports: [] }))).toBe(
      'internal.zsm.local',
    );
  });
});
