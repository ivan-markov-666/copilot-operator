'use client';

/**
 * The line under every folder field and every model picker that says where the default is.
 *
 * Each session keeps its own folder and its own model, and that stays true — but somebody who
 * has set a default once should not have to remember it, and somebody who has not should be
 * able to find the place to set it from wherever they noticed they wanted one. So each hint
 * does both: it offers the default where the field is not already on it, and it always links
 * to the page the default lives on.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, type ModelCatalogue, type ProjectDefault } from '../lib/api';
import { useT } from '../lib/i18n';

export function ProjectHint({ current, onUse }: { current: string; onUse?: (dir: string) => void }) {
  const { t } = useT();
  const [project, setProject] = useState<ProjectDefault | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .project()
      .then((p) => {
        if (!cancelled) setProject(p);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!project) return null;
  const dir = project.rootDir.trim();

  return (
    <Hint
      label={dir ? t('proj.defaultIs', { dir }) : t('proj.noneShort')}
      offer={dir && onUse && current.trim() !== dir ? { text: t('proj.useIt'), onUse: () => onUse(dir) } : undefined}
      link={dir ? t('proj.change') : t('proj.setIt')}
      anchor="project"
    />
  );
}

export function ModelHint({ current, onUse }: { current: string; onUse?: (name: string) => void }) {
  const { t } = useT();
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .models()
      .then((c) => {
        if (!cancelled) setCatalogue(c);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!catalogue) return null;
  const name = catalogue.defaultModel.trim();

  return (
    <Hint
      label={name ? t('def.modelDefaultIs', { name }) : t('def.modelNoneShort')}
      offer={name && onUse && current.trim() !== name ? { text: t('def.modelUseIt'), onUse: () => onUse(name) } : undefined}
      link={name ? t('proj.change') : t('proj.setIt')}
      anchor="model"
    />
  );
}

/** One shape for both, so a folder hint and a model hint never drift apart. */
function Hint({
  label,
  offer,
  link,
  anchor,
}: {
  label: string;
  offer?: { text: string; onUse: () => void };
  link: string;
  anchor: 'project' | 'model';
}) {
  return (
    <p className="muted small" style={{ marginTop: 4 }}>
      {label}{' '}
      {offer && (
        <>
          ·{' '}
          <button type="button" className="linkish" onClick={offer.onUse}>
            {offer.text}
          </button>{' '}
        </>
      )}
      · <Link href={`/defaults#${anchor}`}>{link}</Link>
    </p>
  );
}
