'use client';

import { useEffect, useState } from 'react';
import { api, fmtTime, type Preset } from '../../lib/api';

export default function PresetsPage() {
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
      setMsg(`Saved "${name}".`);
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
    if (!confirm(`Delete preset "${p.name}"?`)) return;
    await api.deletePreset(p.name);
    await load();
  };

  return (
    <>
      <div className="panel">
        <h2>Level 2 presets</h2>
        <p className="muted small">
          Level 2 is what you know and the runner does not: the project, the domain, the team&apos;s conventions, the
          tools in use. It is sent with every task and can be different for every task. Save the ones you reuse here
          and pick them when adding a task. Level 1 always has priority over anything written here.
        </p>
        <label>Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. payments-service team" />
        <label>Instructions</label>
        <textarea
          className="prose"
          style={{ minHeight: 220 }}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={'Project: ...\nRepository layout: ...\nHow we run tests: ...\nThings never to touch: ...'}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" onClick={() => void save()} disabled={!name.trim()}>
            Save preset
          </button>
          <span className="muted small">{msg}</span>
        </div>
      </div>

      <div className="panel">
        <h2>Saved</h2>
        {presets.length === 0 && <div className="muted">None yet.</div>}
        {presets.map((p) => (
          <div key={p.name} className="task">
            <div className="row">
              <h4 className="grow">{p.name}</h4>
              <span className="muted small">{fmtTime(p.updatedAt)}</span>
              <button onClick={() => edit(p)}>Edit</button>
              <button className="danger" onClick={() => void remove(p)}>
                Delete
              </button>
            </div>
            <details>
              <summary>show</summary>
              <pre>{p.content}</pre>
            </details>
          </div>
        ))}
      </div>
    </>
  );
}
