import { useMemo, useState } from 'react';
import type { Host, Port } from '../types';
import { AD_PORTS } from '../lib/ad';

type Col = 'number' | 'protocol' | 'state' | 'service' | 'product';

export default function PortsTable({ host }: { host: Host }) {
  const [sort, setSort] = useState<{ col: Col; dir: 1 | -1 }>({ col: 'number', dir: 1 });

  const rows = useMemo(() => {
    const val = (p: Port): string | number => {
      switch (sort.col) {
        case 'number':
          return p.number;
        case 'protocol':
          return p.protocol;
        case 'state':
          return p.state;
        case 'service':
          return p.service ?? '';
        case 'product':
          return `${p.product ?? ''} ${p.version ?? ''}`.trim();
      }
    };
    return [...host.ports].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      const c = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return c * sort.dir;
    });
  }, [host, sort]);

  if (host.ports.length === 0) {
    return <p className="p-4 text-xs text-ink-3">No port data in this scan for {host.ip}.</p>;
  }

  const Th = ({ col, children, className = '' }: { col: Col; children: React.ReactNode; className?: string }) => (
    <th
      className={`cursor-pointer select-none px-2 py-1.5 text-left font-medium text-ink-3 hover:text-ink-1 ${className}`}
      onClick={() => setSort((s) => ({ col, dir: s.col === col ? ((s.dir * -1) as 1 | -1) : 1 }))}
    >
      {children}
      {sort.col === col && <span className="ml-0.5 text-accent">{sort.dir === 1 ? '↑' : '↓'}</span>}
    </th>
  );

  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse font-mono text-[12px]">
        <thead className="sticky top-0 bg-panel">
          <tr className="border-b border-line">
            <Th col="number">Port</Th>
            <Th col="protocol">Proto</Th>
            <Th col="state">State</Th>
            <Th col="service">Service</Th>
            <Th col="product" className="max-md:hidden">
              Product / version
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={`${p.protocol}-${p.number}`} className="border-b border-line/50 hover:bg-raise/50">
              <td className="px-2 py-1.5 text-ink-1">
                {p.number}
                {p.state === 'open' && AD_PORTS[p.number] && (
                  <span className="ml-1 text-warn" title={`Active Directory service: ${AD_PORTS[p.number]}`}>
                    ✦
                  </span>
                )}
              </td>
              <td className="px-2 py-1.5 text-ink-2">{p.protocol}</td>
              <td className={`px-2 py-1.5 ${p.state === 'open' ? 'text-ok' : 'text-ink-3'}`}>{p.state}</td>
              <td className="px-2 py-1.5 text-ink-1">{p.service ?? '—'}</td>
              <td className="px-2 py-1.5 text-ink-2 max-md:hidden">
                {p.product ? `${p.product}${p.version ? ' ' + p.version : ''}` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
