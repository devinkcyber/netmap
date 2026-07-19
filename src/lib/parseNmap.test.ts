import { describe, it, expect } from 'vitest';
import { parseNmapXml } from './parseNmap';
import { openPorts } from '../types';

const SAMPLE = `<?xml version="1.0"?>
<nmaprun scanner="nmap" args="nmap -sV -O --traceroute -oX scan.xml 10.0.0.0/24" start="1700000000" version="7.94">
  <host starttime="1700000000" endtime="1700000100">
    <status state="up"/>
    <address addr="10.0.0.5" addrtype="ipv4"/>
    <address addr="00:11:22:33:44:55" addrtype="mac" vendor="VMware"/>
    <hostnames><hostname name="dc01.zsm.local" type="PTR"/></hostnames>
    <ports>
      <port protocol="tcp" portid="88"><state state="open"/><service name="kerberos-sec" product="Microsoft Windows Kerberos"/></port>
      <port protocol="tcp" portid="445"><state state="open"/><service name="microsoft-ds"/></port>
      <port protocol="tcp" portid="9999"><state state="closed"/><service name="foo"/></port>
    </ports>
    <os>
      <osmatch name="Linux 5.X" accuracy="88"/>
      <osmatch name="Microsoft Windows Server 2019" accuracy="97"/>
    </os>
    <trace>
      <hop ttl="2" ipaddr="10.0.0.1"/>
      <hop ttl="1" ipaddr="192.168.1.1"/>
      <hop ttl="3" ipaddr="10.0.0.5"/>
    </trace>
  </host>
  <host>
    <status state="down"/>
    <address addr="10.0.0.9" addrtype="ipv4"/>
  </host>
</nmaprun>`;

describe('parseNmapXml', () => {
  it('parses hosts, addresses, and scan metadata', () => {
    const scan = parseNmapXml(SAMPLE);
    expect(scan.hosts).toHaveLength(2);
    expect(scan.meta.scanner).toBe('nmap');
    expect(scan.meta.args).toContain('--traceroute');

    const dc = scan.hosts[0];
    expect(dc.ip).toBe('10.0.0.5');
    expect(dc.hostnames).toEqual(['dc01.zsm.local']);
    expect(dc.mac).toBe('00:11:22:33:44:55');
    expect(dc.vendor).toBe('VMware');
    expect(dc.state).toBe('up');
  });

  it('keeps the highest-accuracy OS match', () => {
    const dc = parseNmapXml(SAMPLE).hosts[0];
    expect(dc.os).toBe('Microsoft Windows Server 2019');
    expect(dc.osAccuracy).toBe(97);
  });

  it('records every port; openPorts filters to open ones', () => {
    const dc = parseNmapXml(SAMPLE).hosts[0];
    expect(dc.ports).toHaveLength(3);
    expect(openPorts(dc).map((p) => p.number).sort((a, b) => a - b)).toEqual([88, 445]);
  });

  it('orders traceroute hops by TTL', () => {
    const dc = parseNmapXml(SAMPLE).hosts[0];
    expect(dc.hops).toEqual(['192.168.1.1', '10.0.0.1', '10.0.0.5']);
  });

  it('marks down hosts', () => {
    const down = parseNmapXml(SAMPLE).hosts[1];
    expect(down.ip).toBe('10.0.0.9');
    expect(down.state).toBe('down');
  });

  it('throws a helpful error on XML that is not nmap output', () => {
    expect(() => parseNmapXml('<foo><bar/></foo>')).toThrow(/nmaprun/);
  });
});
