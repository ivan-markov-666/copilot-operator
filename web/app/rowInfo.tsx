'use client';

/**
 * The "what are these?" button, for a row of links that assume you already know.
 *
 * A task's row offers six ways into what happened — the task's own page, its log, the
 * conversation, and three JSON files called plan, work and runner — and every one of them is a
 * word. The words are accurate and they are useless to anybody who has not read the code: told
 * to hand a file to a chat model, an operator has no way to tell which of the three answers the
 * question they actually have. The tooltips said so all along, on hover, one at a time, which is
 * the one place nobody looks when the question is "which of these do I want".
 *
 * So this puts the same sentences somewhere a person can read them together and compare, and
 * ends with the line the tooltips could never carry: which one to reach for first.
 */
import { useState } from 'react';

import { useT } from '../lib/i18n';
import { RichText } from './richText';

export function RowInfo() {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="info-dot"
        aria-expanded={open}
        aria-label={t('row.info')}
        title={t('row.info')}
        onClick={() => setOpen((v) => !v)}
      >
        i
      </button>
      {open && (
        <div className="notice info-panel">
          <strong>{t('row.infoTitle')}</strong>
          <dl className="small">
            <dt>{t('reg.openTask')}</dt>
            <dd>{t('row.infoOpenTask')}</dd>
            <dt>{t('save.log')}</dt>
            <dd>{t('save.why')}</dd>
            <dt>{t('home.col.chat')}</dt>
            <dd>{t('row.infoChat')}</dd>
          </dl>
          <div className="small" style={{ marginTop: 6 }}>
            {t('row.infoExports')}
          </div>
          <dl className="small">
            <dt>{t('reg.exportPlan')}</dt>
            <dd>{t('reg.exportPlanWhy')}</dd>
            <dt>{t('reg.exportDomain')}</dt>
            <dd>{t('reg.exportDomainWhy')}</dd>
            <dt>{t('reg.exportBot')}</dt>
            <dd>{t('reg.exportBotWhy')}</dd>
          </dl>
          {/* Bold in this one is meaningful: it names the three files as the row spells them. */}
          <RichText text={t('row.infoWhich')} className="small" />
        </div>
      )}
    </>
  );
}
