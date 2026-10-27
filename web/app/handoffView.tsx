'use client';

/**
 * Commands the chat handed to the operator to run themselves (operator, 2026-10-26: "the script is made, but the user
 * runs it; the bot gives the commands for the user to run and the result it expects"): what they are for, the folder,
 * the lines in order with "Copy", what should be seen, the lines the bot itself would refuse, and the scripts they run,
 * each folded with its SHA-256 — what the operator reads is what they run. Shown in the conversation and on a queue
 * task's card alike; each says how it is answered.
 */
import type { HandoffCard } from '../lib/api';
import { useT } from '../lib/i18n';
import { CopyButton } from './copyButton';
import { RichText } from './richText';

export function HandoffDetails({ card, why }: { card: HandoffCard; why: string }) {
  const { t } = useT();
  const commands = card.commands.join('\n');
  return (
    <div className="ho-details">
      <p className="small">{t('ho.intro')}</p>
      {why && <RichText text={why} />}
      <p className="small ho-folder">
        <span className="muted">{t('ho.folder')}</span> <code dir="ltr">{card.cwd}</code>
      </p>
      {card.outside && <p className="reason small">{t('ho.outside')}</p>}
      <p className="cs-who">{t('ho.commands')}</p>
      <pre className="cs-out ho-commands" dir="ltr">{commands}</pre>
      <div className="cs-copy-row">
        <CopyButton text={commands} what="ho.copyCommands" />
      </div>
      {(card.warnings?.length ?? 0) > 0 && (
        <div className="err ho-warn" role="alert">
          <p className="small">{t('ho.warn')}</p>
          <ul className="small">
            {card.warnings!.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="cs-who">{t('ho.expect')}</p>
      <RichText text={card.expect} />
      {card.files.length > 0 && (
        <div className="ho-files">
          {card.files.map((f) => (
            <details key={f.path} className="ho-file">
              <summary className="small">
                <code dir="ltr">{f.path}</code> {f.problem ? <span className="reason">{f.problem}</span> : <span className="muted">{t('ho.files')}</span>}
              </summary>
              {f.sha256 && (
                <p className="small muted ho-sha" dir="ltr">
                  {t('ho.sha', { hash: f.sha256 })}
                </p>
              )}
              {f.cut && <p className="small muted">{t('ho.cut')}</p>}
              {f.text !== undefined && (
                <>
                  <pre className="cs-out" dir="ltr">{f.text}</pre>
                  <div className="cs-copy-row">
                    <CopyButton text={f.text} what="ho.copyFile" />
                  </div>
                </>
              )}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
