'use client';

import { useEffect, useState } from 'react';
import { api, type Preset } from '../../lib/api';
import { confirmDialog } from '../dialog';
import { useT, useFmtTime } from '../../lib/i18n';

export default function PresetsPage() {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => setPresets(await api.presets());
  useEffect(() => {
    void load().catch((e) => setMsg((e as Error).message));
  }, []);

  const save = async () => {
    try {
      await api.savePreset(name, content);
      setMsg(t('presets.saved', { name }));
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const edit = (p: Preset) => {
    setName(p.name);
    setContent(p.content);
  };
  const remove = async (p: Preset) => {
    if (!(await confirmDialog(t('presets.deleteConfirm', { name: p.name })))) return;
    await api.deletePreset(p.name);
    await load();
  };

  return (
    <>
      <div className="panel">
        <h2>{t('presets.title')}</h2>
        <p className="muted small">{t('presets.hint')}</p>
        <label>{t('presets.name')}</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('presets.namePlaceholder')} />
        <label>{t('presets.content')}</label>
        <textarea
          className="prose"
          style={{ minHeight: 220 }}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t('presets.contentPlaceholder')}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" onClick={() => void save()} disabled={!name.trim()}>
            {t('presets.save')}
          </button>
          <span className="muted small">{msg}</span>
        </div>
      </div>

      <div className="panel">
        <h2>{t('presets.list')}</h2>
        {presets.length === 0 && <div className="muted">{t('presets.none')}</div>}
        {presets.map((p) => (
          <div key={p.name} className="task">
            <div className="row">
              <h4 className="grow">{p.name}</h4>
              <span className="muted small">{fmtTime(p.updatedAt)}</span>
              <button onClick={() => edit(p)}>{t('presets.edit')}</button>
              <button className="danger" onClick={() => void remove(p)}>
                {t('presets.delete')}
              </button>
            </div>
            <details>
              <summary>{t('presets.show')}</summary>
              <pre>{p.content}</pre>
            </details>
          </div>
        ))}
      </div>
    </>
  );
}
