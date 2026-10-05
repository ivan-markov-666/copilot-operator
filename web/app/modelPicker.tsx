'use client';

/**
 * The one picker for a Copilot model, wherever one is chosen.
 *
 * The list is never written into this project: it is whatever the chat's own picker offered
 * when it was last read, grouped as it came, with the disabled ones still shown so a saved
 * choice that has since gone stays visible instead of silently vanishing. A picker given no
 * catalogue reads it itself, so a panel that only needs the one control does not have to
 * carry the loading.
 */

import { useEffect, useState } from 'react';
import { api, type ModelCatalogue } from '../lib/api';
import { useT } from '../lib/i18n';

export function useModelCatalogue(given?: ModelCatalogue | null): ModelCatalogue | null {
  const [loaded, setLoaded] = useState<ModelCatalogue | null>(null);
  useEffect(() => {
    if (given !== undefined) return;
    let live = true;
    api
      .models()
      .then((c) => {
        if (live) setLoaded(c);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [given]);
  return given !== undefined ? given : loaded;
}

export function ModelPicker({
  id,
  chosen,
  onChange,
  none,
  catalogue,
  disabled = false,
  style,
}: {
  id: string;
  chosen: string;
  onChange: (name: string) => void;
  /** What the empty choice means here: "leave the chat alone", "the session's own", ... */
  none: string;
  /** Leave out to let the picker read the list itself. */
  catalogue?: ModelCatalogue | null;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  const { t } = useT();
  const list = useModelCatalogue(catalogue);
  const all = list?.options ?? [];
  /*
   * The page spells one model "GPT 5.6 Sol Think deeper" one day and "GPT-5.6 Sol Think deeper" the next, so
   * the saved name is matched as the bot matches it (src/transport/modelMatch.ts), not letter for letter:
   * otherwise a model chosen from this very list showed as "not in the list" after the next read.
   */
  const norm = (n: string): string => n.toLowerCase().replace(/[-‐‑‒–—_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const listed = chosen ? all.find((o) => norm(o.name) === norm(chosen)) : undefined;
  const value = listed?.name ?? chosen;
  const known = !!listed;
  const ungrouped = all.filter((o) => !o.group);
  const grouped = new Map<string, typeof all>();
  for (const o of all) {
    if (!o.group) continue;
    grouped.set(o.group, [...(grouped.get(o.group) ?? []), o]);
  }
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} style={{ width: 'auto', minWidth: 280, ...style }}>
      <option value="">{none}</option>
      {chosen && !known && <option value={chosen}>{t('model.notInList', { name: chosen })}</option>}
      {ungrouped.map((o) => (
        <option key={o.name} value={o.name} disabled={o.disabled}>
          {o.name}
          {o.disabled ? ` — ${t('model.unavailable')}` : ''}
        </option>
      ))}
      {[...grouped.entries()].map(([group, items]) => (
        <optgroup key={group} label={group}>
          {items.map((o) => (
            <option key={o.name} value={o.name} disabled={o.disabled}>
              {o.name}
              {o.disabled ? ` — ${t('model.unavailable')}` : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
