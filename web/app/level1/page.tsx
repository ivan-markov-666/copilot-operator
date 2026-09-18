'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';

export default function Level1Page() {
  const { t } = useT();
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const [customised, setCustomised] = useState(false);
  const [msg, setMsg] = useState('');

  const load = async () => {
    const l = await api.level1();
    setContent(l.content);
    setSaved(l.content);
    setCustomised(l.customised);
  };
  useEffect(() => {
    void load().catch((e) => setMsg((e as Error).message));
  }, []);

  const save = async () => {
    try {
      await api.setLevel1(content);
      setSaved(content);
      setCustomised(true);
      setMsg(t('l1page.saved'));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const reset = async () => {
    if (!confirm(t('l1page.resetConfirm'))) return;
    const l = await api.resetLevel1();
    setContent(l.content);
    setSaved(l.content);
    setCustomised(false);
    setMsg(t('l1page.resetDone'));
  };

  return (
    <div className="panel">
      <h2>{t('l1page.title')}</h2>
      <p className="muted small">{t('l1page.hint')}</p>
      <div className="row small muted">
        <span>{customised ? t('l1page.custom') : t('l1page.shipped')}</span>
        <span className="grow" />
        {content !== saved && <span>{t('l1page.unsaved')}</span>}
      </div>
      <textarea className="prose" style={{ minHeight: 520 }} value={content} onChange={(e) => setContent(e.target.value)} />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" onClick={() => void save()} disabled={content === saved}>
          {t('l1page.save')}
        </button>
        <button onClick={() => void reset()} disabled={!customised}>
          {t('l1page.reset')}
        </button>
        <span className="muted small">{msg}</span>
      </div>
    </div>
  );
}
