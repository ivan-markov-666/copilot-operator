'use client';

/**
 * Kerrigan, as a text to take away (2026-10-20: "a Kerrigan button: the user chooses to save it as a file or copy it to
 * the clipboard; the Kerrigan persona, which explains to the chats what copilot-operator is and in what form a task is
 * best given; wished for, not required — the chat must work well without her"). The text is the persona, in the
 * language of the page, for a conversation with any chat the operator likes; nothing here sends it anywhere, and the
 * bot's own chat never needs it. Read when the menu opens, so the copy happens straight from the press. A skill chosen
 * beside it goes with her text (2026-10-26), the same choice as under the chat's box.
 */
import { useEffect, useState } from 'react';
import { api, type KerriganText, type Skill, type Workspace } from '../../lib/api';
import { useChosenSkill } from '../../lib/chosenSkill';
import { useT, type Key } from '../../lib/i18n';
import { copyText } from '../copyButton';
import { InfoTip, usePopover } from '../popover';

/**
 * What Kerrigan is and what she is for, said where there is room for it (operator, 2026-10-22: "in the empty space
 * under the Kerrigan drop-down, what it is and its use cases; short and clear"). The ⓘ beside the button keeps the
 * whole story.
 */
export function KerriganAbout() {
  const { t } = useT();
  return (
    <section className="kerrigan-about" aria-labelledby="kerrigan-about-title">
      <h3 id="kerrigan-about-title">{t('kerrigan.aboutTitle')}</h3>
      <p>{t('kerrigan.aboutWhat')}</p>
      <p className="kerrigan-about-uses">{t('kerrigan.aboutUses')}</p>
      <ul>
        <li>{t('kerrigan.aboutUse1')}</li>
        <li>{t('kerrigan.aboutUse2')}</li>
        <li>{t('kerrigan.aboutUse3')}</li>
      </ul>
      <p>{t('kerrigan.aboutHow', { button: t('kerrigan.button'), copy: t('kerrigan.copy'), save: t('kerrigan.save') })}</p>
      <p className="muted small">{t('kerrigan.aboutNote')}</p>
    </section>
  );
}

export function KerriganButton({ workspace }: { workspace?: Workspace | null }) {
  const { t, locale } = useT();
  const pop = usePopover('below');
  const [said, setSaid] = useState('');
  /*
   * The skill that goes with her text (operator, 2026-10-26: "a second Skill drop-down beside Kerrigan's; chosen in
   * either, it changes in the other"): the chat's own choice, offered as the chat offers it — the skills for every
   * project and for the open folder.
   */
  const [skill, setSkill] = useChosenSkill();
  const [skills, setSkills] = useState<Skill[]>([]);
  useEffect(() => {
    api.skills().then((r) => setSkills(r.skills)).catch(() => undefined);
  }, []);
  const folderKey = (d: string): string => d.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  const skillsHere = skills.filter((k) => !k.projectDir || (workspace?.ok && folderKey(k.projectDir) === folderKey(workspace.dir)));

  /*
   * Read each time the menu opens: she carries the projects of Settings with their branches, which change. In a language
   * she is not written out in, the names of the controls come back as ⟦key⟧, filled in here from this page's dictionary,
   * so she quotes what is on this screen, in its language.
   */
  const read = async (): Promise<KerriganText | null> => {
    try {
      const got = await api.kerrigan(locale, skill || undefined);
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
        {skillsHere.length > 0 && (
          <span className="kerrigan-skill">
            <label htmlFor="kerrigan-skill" className="cs-pick-label">
              {t('chat.skill')}
            </label>
            <select id="kerrigan-skill" value={skill} onChange={(e) => setSkill(e.target.value)}>
              <option value="">{t('chat.skillNone')}</option>
              {skillsHere.map((k) => (
                <option key={k.name} value={k.name} title={k.description || undefined}>
                  /{k.name}
                </option>
              ))}
            </select>
            <InfoTip label={t('info.about', { name: t('chat.skill') })} text={t('kerrigan.skillWhy')} />
          </span>
        )}
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
