'use client';

/**
 * Theme and accessibility, on one page.
 *
 * Each control changes the page under the person's hands as they tick it, and the example at
 * the bottom shows the parts of the interface that carry meaning in colour, so the effect of a
 * choice is visible without having to go and find a running task.
 */

import { useAppearance, type TextSize, type Theme } from '../../lib/appearance';
import { useT, type Key } from '../../lib/i18n';

export default function AppearancePage() {
  const { t } = useT();
  const { appearance, set, reset, loaded } = useAppearance();

  const themes: Array<{ value: Theme; label: Key }> = [
    { value: 'light', label: 'theme.light' },
    { value: 'dark', label: 'theme.dark' },
  ];
  const sizes: Array<{ value: TextSize; label: Key }> = [
    { value: 'normal', label: 'ap.sizeNormal' },
    { value: 'large', label: 'ap.sizeLarge' },
    { value: 'huge', label: 'ap.sizeHuge' },
  ];
  return (
    <>
      <div className="panel">
        <h2>{t('ap.title')}</h2>
        <p className="muted small">{t('ap.hint')}</p>

        <h3>{t('ap.theme')}</h3>
        <div className="segmented" role="group" aria-label={t('ap.theme')}>
          {themes.map((o) => (
            <button key={o.value} type="button" aria-pressed={loaded && appearance.theme === o.value} onClick={() => set({ theme: o.value })}>
              {t(o.label)}
            </button>
          ))}
        </div>
        <p className="muted small" style={{ marginTop: 6 }}>
          {t('ap.themeWhy')}
        </p>
      </div>

      <div className="panel">
        <h2>{t('ap.a11y')}</h2>
        <p className="muted small">{t('ap.a11yHint')}</p>

        <h3>{t('ap.size')}</h3>
        <div className="segmented" role="group" aria-label={t('ap.size')}>
          {sizes.map((o) => (
            <button key={o.value} type="button" aria-pressed={loaded && appearance.textSize === o.value} onClick={() => set({ textSize: o.value })}>
              {t(o.label)}
            </button>
          ))}
        </div>
        <p className="muted small" style={{ marginTop: 6 }}>
          {t('ap.sizeWhy')}
        </p>

        <Toggle name="highContrast" label="ap.contrast" why="ap.contrastWhy" />
        <Toggle name="reduceMotion" label="ap.motion" why="ap.motionWhy" />
        <Toggle name="underlineLinks" label="ap.links" why="ap.linksWhy" />
        <Toggle name="strongFocus" label="ap.focus" why="ap.focusWhy" />

        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={reset}>{t('ap.reset')}</button>
        </div>
      </div>

      <div className="panel">
        <h2>{t('ap.example')}</h2>
        <p className="small">
          {t('ap.exampleText')} <a href="#main">{t('ap.exampleLink')}</a>
        </p>
        <div className="row">
          <span className="badge done">{t('status.done')}</span>
          <span className="badge running">{t('status.running')}</span>
          <span className="badge waiting-approval">{t('status.waiting-approval')}</span>
          <span className="badge failed">{t('status.failed')}</span>
        </div>
        <div className="summary" style={{ marginTop: 10 }}>
          <strong>{t('task.whatWasDone')}</strong>
          <div>{t('ap.exampleText')}</div>
        </div>
        <div className="row">
          <button className="primary">{t('approval.run')}</button>
          <button>{t('approval.skip')}</button>
          <button className="danger">{t('approval.abort')}</button>
        </div>
      </div>
    </>
  );
}

function Toggle({ name, label, why }: { name: 'highContrast' | 'reduceMotion' | 'underlineLinks' | 'strongFocus'; label: Key; why: Key }) {
  const { t } = useT();
  const { appearance, set } = useAppearance();
  return (
    <div className="option">
      <label>
        <input type="checkbox" checked={appearance[name]} onChange={(e) => set({ [name]: e.target.checked })} />
        <span>{t(label)}</span>
      </label>
      <p className="why">{t(why)}</p>
    </div>
  );
}
