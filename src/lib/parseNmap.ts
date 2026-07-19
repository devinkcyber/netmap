import type { Host, ParsedScan, Port } from '../types';

/**
 * Parse `nmap -oX` output into the internal model.
 *
 * Nmap's XML is its native, documented format, so we read it directly with
 * DOMParser. OS detection (-O), service versions (-sV) and traceroute
 * (--traceroute) are all optional — every read below tolerates their absence.
 * Throws with a human-readable message only when the input isn't nmap XML at all.
 */
export function parseNmapXml(xml: string): ParsedScan {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('That file is not well-formed XML. Export the scan with `nmap -oX scan.xml …` and try again.');
  }
  const run = doc.querySelector('nmaprun');
  if (!run) {
    throw new Error('No <nmaprun> root element found — this XML does not look like nmap -oX output.');
  }

  const warnings: string[] = [];
  const byIp = new Map<string, Host>();

  doc.querySelectorAll('nmaprun > host').forEach((el) => {
    const host = parseHost(el, warnings);
    if (!host) return;
    if (byIp.has(host.ip)) warnings.push(`Duplicate <host> entry for ${host.ip}; keeping the last one.`);
    byIp.set(host.ip, host);
  });

  const hosts = [...byIp.values()];
  if (hosts.length === 0) warnings.push('The file parsed, but contained no <host> entries.');

  return {
    hosts,
    meta: {
      args: attr(run, 'args'),
      startstr: attr(run, 'startstr'),
      scanner: attr(run, 'scanner'),
      version: attr(run, 'version'),
    },
    warnings,
  };
}

function parseHost(el: Element, warnings: string[]): Host | null {
  // Addresses: ipv4/ipv6 → ip, mac → mac + vendor
  let ip: string | undefined;
  let mac: string | undefined;
  let vendor: string | undefined;
  el.querySelectorAll(':scope > address').forEach((a) => {
    const type = attr(a, 'addrtype');
    const addr = attr(a, 'addr');
    if (!addr) return;
    if (type === 'ipv4' || type === 'ipv6') ip = ip ?? addr;
    else if (type === 'mac') {
      mac = addr;
      vendor = attr(a, 'vendor') ?? vendor;
    }
  });
  if (!ip) {
    warnings.push('Skipped a <host> with no IP address.');
    return null;
  }

  const state = attr(el.querySelector(':scope > status'), 'state') === 'down' ? 'down' : 'up';

  const hostnames = [...el.querySelectorAll(':scope > hostnames > hostname')]
    .map((h) => attr(h, 'name'))
    .filter((n): n is string => !!n);

  const ports: Port[] = [...el.querySelectorAll(':scope > ports > port')].flatMap((p) => {
    const number = Number(attr(p, 'portid'));
    if (!Number.isFinite(number)) return [];
    const protocol = attr(p, 'protocol') === 'udp' ? 'udp' : 'tcp';
    const svc = p.querySelector(':scope > service');
    return [
      {
        number,
        protocol,
        state: attr(p.querySelector(':scope > state'), 'state') ?? 'unknown',
        service: attr(svc, 'name'),
        product: attr(svc, 'product'),
        version: attr(svc, 'version'),
      } satisfies Port,
    ];
  });

  // OS detection (optional): pick the highest-accuracy osmatch
  let os: string | undefined;
  let osAccuracy: number | undefined;
  el.querySelectorAll(':scope > os > osmatch').forEach((m) => {
    const acc = Number(attr(m, 'accuracy') ?? 0);
    if (osAccuracy === undefined || acc > osAccuracy) {
      osAccuracy = acc;
      os = attr(m, 'name');
    }
  });

  // Traceroute (optional): ordered hops, scanner → target
  const hopEls = [...el.querySelectorAll(':scope > trace > hop')];
  const hops = hopEls.length
    ? hopEls
        .map((h) => ({ ttl: Number(attr(h, 'ttl') ?? 0), ip: attr(h, 'ipaddr') }))
        .filter((h): h is { ttl: number; ip: string } => !!h.ip)
        .sort((a, b) => a.ttl - b.ttl)
        .map((h) => h.ip)
    : undefined;

  const end = Number(attr(el, 'endtime') ?? attr(el, 'starttime'));
  const lastSeen = Number.isFinite(end) && end > 0 ? new Date(end * 1000).toISOString() : undefined;

  return { id: ip, ip, hostnames, mac, vendor, os, osAccuracy, state, ports, hops, lastSeen };
}

function attr(el: Element | null, name: string): string | undefined {
  const v = el?.getAttribute(name);
  return v === null || v === undefined || v === '' ? undefined : v;
}
