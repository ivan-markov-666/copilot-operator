/**
 * The logo and the icon (operator, 2026-10-22: "one logo for the light theme and one for the dark; the aeroplane
 * alone as the web part's icon, seen well on light and dark browser themes — dark blue, with a light white outline").
 *
 * - drawn once (`web/lib/brand.ts`): the tab's icon and the two logo files are exactly what it draws;
 * - the aeroplane turns about its centre without leaving its box;
 * - the icon is seen on a light tab and on a dark one: its dark blue against a light tab, its white edge against a
 *   dark one, each by WCAG's contrast;
 * - the page's own logo takes the same two colours from the theme.
 *
 *   npm run check:brand
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HULL, LOGO_COLOURS, PLANE, iconSvg, logoSvg } from '../web/lib/brand.js';
import { Tally } from './support/harness.js';

const t = new Tally();
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (...p: string[]): string => readFileSync(join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

console.log('--- drawn once ---');
t.check('the tab\'s icon is what brand.ts draws', read('web', 'app', 'icon.svg'), iconSvg());
t.check('and the copy of it in docs/brand', read('docs', 'brand', 'icon.svg'), iconSvg());
t.check('the logo for the light theme', read('docs', 'brand', 'logo-light.svg'), logoSvg('light'));
t.check('the logo for the dark theme', read('docs', 'brand', 'logo-dark.svg'), logoSvg('dark'));
t.truthy('the page\'s own logo draws the same aeroplane and hull', /\bPLANE\b/.test(read('web', 'app', 'logo.tsx')) && /\bHULL\b/.test(read('web', 'app', 'logo.tsx')));

console.log('\n--- the aeroplane turns inside its box ---');
{
  const points = (d: string): Array<[number, number]> => {
    const n = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    return Array.from({ length: n.length / 2 }, (_, i) => [n[2 * i]!, n[2 * i + 1]!]);
  };
  const far = Math.max(...points(PLANE).map(([x, y]) => Math.hypot(x - 50, y - 50)));
  t.truthy("every point, the curves' too, within 48 of the centre: turned, it stays in the 100 × 100 box", far <= 48, far);
  t.truthy('its hull too', Math.max(...points(HULL).map(([x, y]) => Math.hypot(x - 50, y - 50))) <= 48);
}

console.log('\n--- the icon is seen on a light tab and on a dark one ---');
{
  // WCAG's relative luminance and contrast ratio.
  const lum = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string): number => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  const icon = iconSvg();
  const fill = /fill="(#[0-9a-f]{6})"/i.exec(icon)?.[1] ?? '';
  const edge = /stroke="(#[0-9a-f]{6})"/i.exec(icon)?.[1] ?? '';
  t.check('dark blue, with a white edge drawn under it', [fill, edge, /paint-order="stroke"/.test(icon)], ['#0d2a42', '#ffffff', true]);
  // A light browser's tab strip, and a dark one's (Edge's and Chrome's as they are drawn).
  for (const [tab, colour] of [['light', '#dfe3e8'], ['white', '#ffffff']] as const) {
    t.truthy(`on a ${tab} tab its dark blue stands out (contrast ≥ 7)`, contrast(fill, colour) >= 7, contrast(fill, colour).toFixed(1));
  }
  for (const [tab, colour] of [['dark', '#35363a'], ['black', '#202124']] as const) {
    t.truthy(`on a ${tab} tab its white edge stands out (contrast ≥ 7)`, contrast(edge, colour) >= 7, contrast(edge, colour).toFixed(1));
  }
}

console.log('\n--- the page\'s logo takes its colours from the theme ---');
{
  const css = read('web', 'app', 'globals.css');
  const block = (selector: string): string => css.slice(css.indexOf(`${selector} {`), css.indexOf('}', css.indexOf(`${selector} {`)));
  const tokens = (b: string) => [/--logo-plane:\s*(#[0-9a-f]{6})/i.exec(b)?.[1], /--logo-orbit:\s*(#[0-9a-f]{6})/i.exec(b)?.[1]];
  t.check('light: the colours of the light logo', tokens(block(':root')), [LOGO_COLOURS.light.plane, LOGO_COLOURS.light.orbit]);
  t.check("dark: the dark logo's", tokens(block(":root[data-theme='dark']")), [LOGO_COLOURS.dark.plane, LOGO_COLOURS.dark.orbit]);
}

t.finish();
