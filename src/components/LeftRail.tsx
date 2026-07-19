import { useMemo, useState } from 'react';
import { useStore, subnetsOf } from '../store';
import { OS_COLORS, AD_COLORS, DOMAIN_COLORS, SUBNET_COLORS, STATUS_COLORS } from '../lib/encodings';
import { domainsOf, type AdRole } from '../lib/ad';
import { osFamily, type OsFamily } from '../types';
import * as vault from '../lib/vault';

export default function LeftRail() {
  const open = useStore((s) => s.leftOpen);
  if (!open) return null;
  return (
    <aside className="flex w-60 shrink-0 flex-col gap-5 overflow-y-auto border-r border-line bg-panel p-4 max-md:absolute max-md:inset-y-12 max-md:left-0 max-md:z-30 max-md:shadow-2xl">
      <FiltersBlock />
      <EncodingsBlock />
      <Legend />
      <VaultBlock />
    </aside>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-ink-3">{children}</h3>;
}

function FiltersBlock() {
  const hosts = useStore((s) => s.hosts);
  const mask = useStore((s) => s.mask);
  const filters = useStore((s) => s.filters);
  const setFilters = useStore((s) => s.setFilters);
  const noteStatusByIp = useStore((s) => s.noteStatusByIp);
  const sliverImplants = useStore((s) => s.sliverImplants);

  const families = useMemo(() => [...new Set(hosts.map((h) => osFamily(h.os)))].sort(), [hosts]);
  const subnets = useMemo(() => subnetsOf(hosts, mask), [hosts, mask]);
  const statuses = useMemo(() => [...new Set(Object.values(noteStatusByIp))].sort(), [noteStatusByIp]);

  return (
    <section>
      <SectionTitle>Filters</SectionTitle>
      <div className="space-y-2.5">
        <select className="select w-full" value={filters.subnet ?? ''} onChange={(e) => setFilters({ subnet: e.target.value || null })}>
          <option value="">All subnets</option>
          {subnets.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select className="select w-full" value={filters.os ?? ''} onChange={(e) => setFilters({ os: e.target.value || null })}>
          <option value="">All OS families</option>
          {families.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <input
          className="w-full rounded-none border border-line bg-well px-2.5 py-1.5 font-mono text-xs text-ink-1 placeholder:text-ink-3 focus:border-accent focus:outline-none"
          placeholder="Open ports/services (e.g. 80,443,smb)"
          value={filters.port}
          onChange={(e) => setFilters({ port: e.target.value })}
        />
        {statuses.length > 0 && (
          <select className="select w-full" value={filters.status ?? ''} onChange={(e) => setFilters({ status: e.target.value || null })}>
            <option value="">Any note status</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            <option value="no note">no note</option>
          </select>
        )}
        {/* Shown once implants exist; also stays visible while a Sliver filter is set, so a
            stale filter can always be cleared even if every implant just dropped. */}
        {(sliverImplants.length > 0 || filters.sliver) && (
          <select className="select w-full" value={filters.sliver ?? ''} onChange={(e) => setFilters({ sliver: e.target.value || null })}>
            <option value="">Any Sliver state</option>
            <option value="any">Has live implant</option>
            <option value="session">Live session</option>
            <option value="beacon">Live beacon</option>
            <option value="none">No implant</option>
          </select>
        )}
      </div>
    </section>
  );
}

function EncodingsBlock() {
  const colorBy = useStore((s) => s.colorBy);
  const mask = useStore((s) => s.mask);
  const setSetting = useStore((s) => s.setSetting);

  return (
    <section>
      <SectionTitle>Encodings</SectionTitle>
      <div className="space-y-2.5">
        <Row label="Color">
          <select className="select flex-1" value={colorBy} onChange={(e) => setSetting('colorBy', e.target.value as never)}>
            <option value="os">OS family</option>
            <option value="ad">AD role</option>
            <option value="domain">AD domain</option>
            <option value="subnet">Subnet</option>
          </select>
        </Row>
        <Row label="Mask">
          <select className="select flex-1" value={mask} onChange={(e) => setSetting('mask', Number(e.target.value))} title="Prefix length used to infer subnets">
            {[16, 20, 22, 23, 24, 25, 26].map((m) => (
              <option key={m} value={m}>
                /{m}
              </option>
            ))}
          </select>
        </Row>
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 text-xs text-ink-2">{label}</span>
      {children}
    </div>
  );
}

function Legend() {
  const colorBy = useStore((s) => s.colorBy);
  const hosts = useStore((s) => s.hosts);
  const mask = useStore((s) => s.mask);

  let items: { label: string; color: string }[] = [];
  if (colorBy === 'os') {
    const present = new Set(hosts.map((h) => osFamily(h.os)));
    items = (Object.keys(OS_COLORS) as OsFamily[]).filter((f) => present.has(f)).map((f) => ({ label: f, color: OS_COLORS[f] }));
  } else if (colorBy === 'ad') {
    items = (Object.keys(AD_COLORS) as AdRole[]).map((r) => ({ label: r, color: AD_COLORS[r] }));
  } else if (colorBy === 'domain') {
    items = domainsOf(hosts).map((d, i) => ({ label: d, color: DOMAIN_COLORS[i % DOMAIN_COLORS.length] }));
  } else {
    items = subnetsOf(hosts, mask).map((s, i) => ({ label: s, color: SUBNET_COLORS[i % SUBNET_COLORS.length] }));
  }

  return (
    <section>
      <SectionTitle>Legend</SectionTitle>
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li key={it.label} className="flex items-center gap-2 text-xs text-ink-2">
            <span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ background: it.color }} />
            <span className="truncate font-mono">{it.label}</span>
          </li>
        ))}
        <li className="flex items-center gap-2 pt-1 text-xs text-ink-3">
          <svg className="shrink-0" width="19" height="19" viewBox="0 0 13 13">
            <polygon points="6.5,1 11.26,3.75 11.26,9.25 6.5,12 1.74,9.25 1.74,3.75" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          </svg>
          domain controller
        </li>
        <li className="flex items-center gap-2 text-xs text-ink-3">
          <span className="w-5 shrink-0 text-center font-mono text-[16px] font-bold leading-none" style={{ color: '#e879c7' }}>›‹</span> ligolo pivot 📡
        </li>
        <li className="flex items-center gap-2 text-xs text-ink-3">
          <svg className="shrink-0" width="20" height="19" viewBox="0 0 14 13">
            <line x1="1" y1="6.5" x2="13" y2="6.5" stroke="#e879c7" strokeWidth="2.5" strokeDasharray="3 2" />
          </svg>
          path to unlocked subnet
        </li>
        <li className="flex items-center gap-2 text-xs text-ink-3">
          <span className="w-5 shrink-0 text-center text-base">🔑</span> credential on host
        </li>
        <li className="flex items-center gap-2 text-xs text-ink-3">
          <svg className="shrink-0" width="19" height="19" viewBox="0 0 13 13">
            <circle cx="6.5" cy="6.5" r="4.75" fill="none" stroke="#5cc8ff" strokeWidth="1.5" />
          </svg>
          sliver session
        </li>
        <li className="flex items-center gap-2 text-xs text-ink-3">
          {/* Animated to match the graph's beacon ring: a bright arc filling clockwise from 12 o'clock, then resetting. */}
          <svg className="shrink-0" width="19" height="19" viewBox="0 0 13 13">
            <circle cx="6.5" cy="6.5" r="4.75" fill="none" stroke="rgba(92,200,255,0.25)" strokeWidth="1.5" />
            <circle
              cx="6.5"
              cy="6.5"
              r="4.75"
              fill="none"
              stroke="#5cc8ff"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeDasharray="29.85"
              transform="rotate(-90 6.5 6.5)"
            >
              <animate attributeName="stroke-dashoffset" from="29.85" to="0" dur="2s" repeatCount="indefinite" />
            </circle>
          </svg>
          sliver beacon
        </li>
        <li className="flex items-center gap-2 text-xs text-ink-3">
          <span className="h-2 w-3 shrink-0 rotate-45 bg-ink-3/60" style={{ width: 16, height: 16 }} /> router / hop
        </li>
      </ul>
      <div className="mt-3">
        <SectionTitle>Note status ring</SectionTitle>
        <ul className="space-y-1.5">
          {Object.entries(STATUS_COLORS).map(([label, color]) => (
            <li key={label} className="flex items-center gap-2 text-xs text-ink-2">
              <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2" style={{ borderColor: color }} />
              <span className="font-mono">{label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function VaultBlock() {
  const vaultName = useStore((s) => s.vaultName);
  const vaultCounts = useStore((s) => s.vaultCounts);
  const hosts = useStore((s) => s.hosts);
  const hostsFolder = useStore((s) => s.hostsFolder);
  const scanMeta = useStore((s) => s.scanMeta);
  const setSetting = useStore((s) => s.setSetting);
  const setVault = useStore((s) => s.setVault);
  const showToast = useStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);

  async function rescan() {
    const counts = await vault.rebuildIndex();
    setVault(vault.vaultName(), counts, vault.statusByIp(), vault.bloodhoundIdByIp());
    showToast(`Vault rescanned — ${counts.notes} notes, ${counts.matched} matched.`);
  }

  async function bulkCreate() {
    setBusy(true);
    try {
      let created = 0;
      for (const h of hosts) {
        if (!vault.noteForIp(h.ip)) {
          await vault.createNote(h, hostsFolder, scanMeta?.startstr ? new Date(scanMeta.startstr).toISOString().slice(0, 10) : undefined);
          created++;
        }
      }
      const counts = await vault.rebuildIndex();
      setVault(vault.vaultName(), counts, vault.statusByIp(), vault.bloodhoundIdByIp());
      showToast(created ? `Created ${created} host note${created === 1 ? '' : 's'} in ${hostsFolder}/.` : 'Every host already has a note.');
    } catch (e) {
      showToast(`Bulk create failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!vaultName) return null;

  return (
    <section className="mt-auto border-t border-line pt-4">
      <SectionTitle>Vault</SectionTitle>
      <p className="mb-2 text-xs text-ink-2">
        <span className="font-medium text-ink-1">{vaultName}</span>
        {vaultCounts && (
          <>
            {' '}
            · {vaultCounts.notes} notes · {vaultCounts.matched} matched
          </>
        )}
      </p>
      <label className="mb-1 block text-[12px] text-ink-3">New-note folder</label>
      <input
        className="mb-2 w-full rounded-none border border-line bg-well px-2.5 py-1.5 font-mono text-xs text-ink-1 focus:border-accent focus:outline-none"
        value={hostsFolder}
        onChange={(e) => setSetting('hostsFolder', e.target.value)}
      />
      <div className="flex gap-2">
        <button className="btn flex-1" onClick={rescan}>
          Rescan
        </button>
        <button className="btn flex-1" onClick={bulkCreate} disabled={busy || hosts.length === 0} title="Scaffold a note for every host that lacks one">
          {busy ? 'Creating…' : 'Notes for all'}
        </button>
      </div>
    </section>
  );
}
