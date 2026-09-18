'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

export default function Level1Page() {
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
      setMsg('Saved. Applies to sessions started from now on.');
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const reset = async () => {
    if (!confirm('Discard your edits and go back to the contract shipped with the project?')) return;
    const l = await api.resetLevel1();
    setContent(l.content);
    setSaved(l.content);
    setCustomised(false);
    setMsg('Reset to the shipped contract.');
  };

  return (
    <div className="panel">
      <h2>Level 1: the contract with the runner</h2>
      <p className="muted small">
        Sent once at the start of every conversation, before any project instructions. It defines the phases, the
        json format, the stop word, the final summary and the rules that level 2 cannot override. Edit it only if
        you know why: the parser expects exactly the format described here.
      </p>
      <div className="row small muted">
        <span>{customised ? 'Customised copy in data/level1.md' : 'Shipped version, prompts/level1.md'}</span>
        <span className="grow" />
        {content !== saved && <span>unsaved changes</span>}
      </div>
      <textarea className="prose" style={{ minHeight: 520 }} value={content} onChange={(e) => setContent(e.target.value)} />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" onClick={() => void save()} disabled={content === saved}>
          Save
        </button>
        <button onClick={() => void reset()} disabled={!customised}>
          Reset to shipped
        </button>
        <span className="muted small">{msg}</span>
      </div>
    </div>
  );
}
