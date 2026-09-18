'use client';

import Link from 'next/link';
import { LanguageSwitcher, useT } from '../lib/i18n';

export function Nav() {
  const { t } = useT();
  return (
    <nav className="row">
      <Link href="/">{t('nav.sessions')}</Link>
      <Link href="/level1">{t('nav.level1')}</Link>
      <Link href="/presets">{t('nav.presets')}</Link>
      <Link href="/system">{t('nav.system')}</Link>
      <LanguageSwitcher />
    </nav>
  );
}
