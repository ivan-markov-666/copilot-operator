/**
 * The logo and the icon (operator, 2026-10-22: "integrate this logo — one for the light theme and one for the dark;
 * the aeroplane alone as the web part's icon, drawn so it shows on light and dark browser themes: dark blue with a
 * light white outline"). An aeroplane crossing its orbit; drawn here once, for the page's own mark
 * (`app/logo.tsx`), the tab's icon (`app/icon.svg`) and the files in `docs/brand/`, which `check:brand` holds to it.
 */

/**
 * The aeroplane seen from above, nose up, in a 100 × 100 box around (50, 50): a rounded nose, wings swept back, the
 * tailplane small. Every point, the curves' too, is within 48 of the centre, so it turns about it without leaving
 * the box.
 */
export const PLANE =
  'M50 3C54.6 3 56.6 8.2 56.6 14.5L56.6 35.5L91.5 55.8C93.2 56.8 94 58.2 94 60L94 62.6L56.6 52.8L55.4 74.5L69.5 84.6L69.5 89.6L52.6 85.6' +
  'L50 89.8L47.4 85.6L30.5 89.6L30.5 84.6L44.6 74.5L43.4 52.8L6 62.6L6 60C6 58.2 6.8 56.8 8.5 55.8L43.4 35.5L43.4 14.5C43.4 8.2 45.4 3 50 3Z';

/** Its hull — nose, wing tips, tail tips: the orbit parts around all of it, leaving no piece between a wing and the tail. */
export const HULL = 'M50 3L94 60L94 62.6L69.5 89.6L30.5 89.6L6 62.6L6 60Z';

/** Where the aeroplane sits in the logo: 74 wide, turned 42°, to the right of the middle of a 200 × 120 box. */
export const PLANE_AT = 'translate(104 14) scale(0.74) rotate(42 50 50)';

/** The orbit: a turn from low on the left to high on the right, its second turn under the aeroplane, a faint trace. */
export const ORBIT = {
  ellipse: { cx: 96, cy: 64, rx: 86, ry: 36, rotate: -25, width: 6.5 },
  under: { d: 'M70 104 C112 124 166 112 186 86 C194 74 192 60 184 52', width: 6 },
  trace: { d: 'M22 28 C18 42 22 56 34 70', width: 2.4 },
};

/** The two themes' colours: dark blue on light; on dark, the aeroplane light and its orbit the sky blue of the page. */
export const LOGO_COLOURS = {
  light: { plane: '#0d2a42', orbit: '#0d2a42' },
  dark: { plane: '#e3eef9', orbit: '#5ab6f4' },
} as const;

/** The logo as a file, in one theme's colours. */
export function logoSvg(theme: keyof typeof LOGO_COLOURS): string {
  const { plane, orbit } = LOGO_COLOURS[theme];
  const id = `cop-logo-${theme}`;
  const e = ORBIT.ellipse;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120">',
    '<title>copilot-operator</title>',
    '<defs>',
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="120">`,
    '<rect width="200" height="120" fill="#fff"/>',
    `<path d="${HULL}" transform="${PLANE_AT}" fill="#000" stroke="#000" stroke-width="18" stroke-linejoin="round"/>`,
    '</mask>',
    '</defs>',
    `<g mask="url(#${id})" fill="none" stroke="${orbit}" stroke-linecap="round">`,
    `<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" transform="rotate(${e.rotate} ${e.cx} ${e.cy})" stroke-width="${e.width}"/>`,
    `<path d="${ORBIT.under.d}" stroke-width="${ORBIT.under.width}"/>`,
    `<path d="${ORBIT.trace.d}" stroke-width="${ORBIT.trace.width}"/>`,
    '</g>',
    `<path d="${PLANE}" transform="${PLANE_AT}" fill="${plane}"/>`,
    '</svg>',
    '',
  ].join('\n');
}

/** The icon: the aeroplane alone, flying up and to the right, dark blue with a white edge — on a light tab or a dark one. */
export function iconSvg(): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 -6 112 112">',
    '<title>copilot-operator</title>',
    `<path d="${PLANE}" transform="rotate(45 50 50)" fill="#0d2a42" stroke="#ffffff" stroke-width="7" stroke-linejoin="round" paint-order="stroke"/>`,
    '</svg>',
    '',
  ].join('\n');
}
