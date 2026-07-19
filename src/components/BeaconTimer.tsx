import { useEffect, useState } from 'react';
import { beaconProgress, type SliverImplant } from '../lib/sliver';

/**
 * A live progress bar counting down to a beacon's next check-in. Phased on the
 * beacon's real lastCheckin + interval, so it re-syncs whenever the bridge pushes
 * a fresh snapshot on an actual check-in. Ticks locally (~250 ms) between updates.
 */
export default function BeaconTimer({ im }: { im: SliverImplant }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => (n + 1) % 1_000_000), 250);
    return () => clearInterval(id);
  }, []);

  const { progress, remaining, interval } = beaconProgress(im);
  if (!interval) return null;

  return (
    <div className="mt-1" title={`checks in every ${interval}s`}>
      <div className="flex items-center justify-between text-[11px] text-ink-3">
        <span>next check-in</span>
        <span>~{Math.max(0, Math.ceil(remaining))}s</span>
      </div>
      <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-line">
        <div
          className="h-full rounded-full transition-[width] duration-200 ease-linear"
          style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`, background: '#5cc8ff' }}
        />
      </div>
    </div>
  );
}
