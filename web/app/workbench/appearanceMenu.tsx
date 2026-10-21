'use client';

/**
 * How the page looks, from the button in the bar on top, between Settings and System (2026-10-21: "move it up there";
 * it was at the foot of the column of icons). Since 2026-10-20: "let dark and light be set
 * from the button on the left too, not lead to Settings; a System theme as the default; A+ and A−, and the other such
 * options — underlined links, less motion and so on"; "and a night mode to spare the eyes"). The same settings as the
 * Appearance page, changed as they are pressed and kept in this browser: the theme, the text size a step at a time,
 * and the reading aids, night light first.
 */
import { TEXT_SIZES, useAppearance, type Theme } from '../../lib/appearance';
import { useT, type Key } from '../../lib/i18n';
import { usePopover } from '../popover';

const THEMES: Array<{ value: Theme; label: Key }> = [
  { value: 'system', label: 'theme.system' },
  { value: 'light', label: 'theme.light' },
  { value: 'dark', label: 'theme.dark' },
];

const SIZE_NAMES: Record<(typeof TEXT_SIZES)[number], Key> = {
  small: 'ap.sizeSmall',
  normal: 'ap.sizeNormal',
  large: 'ap.sizeLarge',
  huge: 'ap.sizeHuge',
  giant: 'ap.sizeGiant',
};

const AIDS: Array<{ name: 'highContrast' | 'reduceMotion' | 'underlineLinks' | 'strongFocus' | 'nightLight' | 'systemCursor'; label: Key }> = [
  { name: 'nightLight', label: 'ap.night' },
  { name: 'underlineLinks', label: 'ap.links' },
  { name: 'reduceMotion', label: 'ap.motion' },
  { name: 'highContrast', label: 'ap.contrast' },
  { name: 'strongFocus', label: 'ap.focus' },
  // The page draws cursors of its own (2026-10-21); this gives back the ones set in Windows.
  { name: 'systemCursor', label: 'ap.systemCursor' },
];

export function AppearanceMenu() {
  const { t } = useT();
  const { appearance, set, reset, loaded } = useAppearance();
  const pop = usePopover('below');
  const at = TEXT_SIZES.indexOf(appearance.textSize);
  return (
    <>
      <button
        ref={pop.anchor}
        type="button"
        className={`lang-btn ap-btn${pop.open ? ' on' : ''}`}
        aria-label={t('wb.appearance')}
        title={t('wb.appearance')}
        aria-expanded={pop.open}
        aria-controls={pop.open ? pop.id : undefined}
        onClick={pop.toggle}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />
        </svg>
        <span aria-hidden="true">{t('nav.appearance')}</span>
      </button>
      {pop.open && (
        <div ref={pop.panel} id={pop.id} role="dialog" aria-label={t('wb.appearance')} className="pop wb-appear" style={pop.style}>
          <p className="pop-title">{t('wb.appearance')}</p>
          <p className="wb-appear-label" id={`${pop.id}-theme`}>{t('ap.theme')}</p>
          <div className="segmented" role="group" aria-labelledby={`${pop.id}-theme`}>
            {THEMES.map((o) => (
              <button key={o.value} type="button" aria-pressed={loaded && appearance.theme === o.value} onClick={() => set({ theme: o.value })}>
                {t(o.label)}
              </button>
            ))}
          </div>
          <p className="wb-appear-label" id={`${pop.id}-size`}>{t('ap.size')}</p>
          <div className="wb-appear-size" role="group" aria-labelledby={`${pop.id}-size`}>
            <button type="button" aria-label={t('ap.smaller')} title={t('ap.smaller')} disabled={at <= 0} onClick={() => set({ textSize: TEXT_SIZES[at - 1] })}>
              A−
            </button>
            <span aria-live="polite">{t(SIZE_NAMES[appearance.textSize])}</span>
            <button type="button" aria-label={t('ap.larger')} title={t('ap.larger')} disabled={at >= TEXT_SIZES.length - 1} onClick={() => set({ textSize: TEXT_SIZES[at + 1] })}>
              A+
            </button>
          </div>
          {AIDS.map((o) => (
            <label key={o.name} className="wb-appear-aid">
              <input type="checkbox" checked={appearance[o.name]} onChange={(e) => set({ [o.name]: e.target.checked })} />
              <span>{t(o.label)}</span>
            </label>
          ))}
          <div className="row">
            <button type="button" className="quiet small" onClick={reset}>
              {t('ap.reset')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
