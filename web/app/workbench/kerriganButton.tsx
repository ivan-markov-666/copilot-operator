'use client';

/**
 * Kerrigan, as a text to take away (2026-10-20: "a Kerrigan button: the user chooses to save it as a file or copy it to
 * the clipboard; the Kerrigan persona, which explains to the chats what copilot-operator is and in what form a task is
 * best given; wished for, not required — the chat must work well without her"). The text is the persona, in the
 * language of the page, for a conversation with any chat the operator likes; nothing here sends it anywhere, and the
 * bot's own chat never needs it. Read when the menu opens, so the copy happens straight from the press.
 */
import { useState } from 'react';
import { api, type KerriganText } from '../../lib/api';
import { useT, type Key } from '../../lib/i18n';
import { copyText } from '../copyButton';
import { InfoTip, usePopover } from '../popover';

export function KerriganButton() {
  const { t, locale } = useT();
  const pop = usePopover('below');
  const [said, setSaid] = useState('');

  /*
   * Read each time the menu opens: she carries the projects of Settings with their branches, which change. In a language
   * she is not written out in, the names of the controls come back as ⟦key⟧, filled in here from this page's dictionary,
   * so she quotes what is on this screen, in its language.
   */
  const read = async (): Promise<KerriganText | null> => {
    try {
      const got = await api.kerrigan(locale);
      const filled = got.filled ? got : { ...got, text: got.text.replace(/⟦([\w.-]+)⟧/g, (_, key: string) => t(key as Key)) };
      return filled;
    } catch (e) {
      setSaid(t('kerrigan.failed', { reason: (e as Error).message }));
      return null;
    }
  };
  const openMenu = (): void => {
    if (!pop.open) void read();
    pop.toggle();
  };
  const save = async (): Promise<void> => {
    pop.close();
    const got = await read();
    if (!got) return;
    const url = URL.createObjectURL(new Blob([got.text], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = got.fileName;
    a.click();
    URL.revokeObjectURL(url);
    setSaid(t('kerrigan.saved', { name: got.fileName }));
  };
  const copy = async (): Promise<void> => {
    pop.close();
    const got = await read();
    if (!got) return;
    setSaid((await copyText(got.text)) ? t('kerrigan.copied', { n: got.text.length }) : t('kerrigan.copyFailed'));
  };

  return (
    <div className="kerrigan">
      <div className="row">
        <button ref={pop.anchor} type="button" className="primary" aria-haspopup="menu" aria-expanded={pop.open} aria-controls={pop.open ? pop.id : undefined} onClick={openMenu}>
          {t('kerrigan.button')} <span aria-hidden="true">▾</span>
        </button>
        <InfoTip label={t('kerrigan.infoLabel')} text={t('kerrigan.info')} />
      </div>
      {pop.open && (
        <div ref={pop.panel} id={pop.id} role="menu" aria-label={t('kerrigan.menu')} className="pop menu" style={pop.style}>
          <button type="button" role="menuitem" onClick={() => void save()}>
            {t('kerrigan.save')}
          </button>
          <button type="button" role="menuitem" onClick={() => void copy()}>
            {t('kerrigan.copy')}
          </button>
        </div>
      )}
      {said && (
        <p className="small" role="status">
          {said}
        </p>
      )}
    </div>
  );
}
