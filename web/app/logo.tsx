'use client';

/**
 * The logo on the page (2026-10-22): the aeroplane crossing its orbit, in the colours of the theme on — dark blue on
 * light, light with a sky-blue orbit on dark — from `--logo-plane` and `--logo-orbit`. Drawn from `lib/brand.ts`.
 */
import { useId } from 'react';
import { HULL, ORBIT, PLANE, PLANE_AT } from '../lib/brand';

export function Logo({ className = 'brand-logo' }: { className?: string }) {
  // One mask per logo on the page; an id with React's colons in it is not found by every `url(#…)`.
  const mask = `cop-logo-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  const e = ORBIT.ellipse;
  return (
    <svg className={className} viewBox="0 0 200 120" aria-hidden="true" focusable="false">
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="120">
          <rect width="200" height="120" fill="#fff" />
          <path d={HULL} transform={PLANE_AT} fill="#000" stroke="#000" strokeWidth={18} strokeLinejoin="round" />
        </mask>
      </defs>
      <g mask={`url(#${mask})`} fill="none" stroke="var(--logo-orbit)" strokeLinecap="round">
        <ellipse cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} transform={`rotate(${e.rotate} ${e.cx} ${e.cy})`} strokeWidth={e.width} />
        <path d={ORBIT.under.d} strokeWidth={ORBIT.under.width} />
        <path d={ORBIT.trace.d} strokeWidth={ORBIT.trace.width} />
      </g>
      <path className="brand-plane" d={PLANE} transform={PLANE_AT} fill="var(--logo-plane)" />
    </svg>
  );
}
