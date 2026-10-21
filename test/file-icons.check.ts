/**
 * The explorer's file icons on the dark theme (operator, 2026-10-21: "make the file icons suit the dark theme too —
 * lighter ones for it if need be").
 *
 * Each icon's colour is the one its kind is known by, a middle tone chosen for the light theme; on the dark one the
 * same hue is lifted towards white (`darkColor` in `web/lib/fileMarks.ts`). Held here for every mark there is: it
 * stands out from the dark panels at least as text must (WCAG's 4.5:1), it is lighter than the light theme's, and
 * it is still its own colour rather than white.
 *
 *   npm run check:file-icons
 */
import { ALL_MARKS, contrast, darkColor, DARK_CONTRAST, DARK_PANEL, luminance, markOf } from '../web/lib/fileMarks.js';
import { Tally } from './support/harness.js';

const t = new Tally();

const colours = [...new Set(ALL_MARKS.map((m) => m.color.toLowerCase()))];
t.truthy('there are marks to hold', colours.length > 20, colours.length);

const weak = colours.filter((c) => contrast(darkColor(c), DARK_PANEL) < DARK_CONTRAST).map((c) => `${c} → ${darkColor(c)} (${contrast(darkColor(c), DARK_PANEL).toFixed(2)})`);
t.check(`every icon stands out on the dark panels (${DARK_PANEL}) at ${DARK_CONTRAST}:1 at least`, weak, []);

const notLighter = colours.filter((c) => luminance(darkColor(c)) <= luminance(c));
t.check('every dark colour is lighter than its light one', notLighter, []);

const washedOut = colours.filter((c) => contrast(darkColor(c), '#ffffff') < 1.25);
t.check('and none is lifted all the way to white', washedOut, []);

const before = colours.filter((c) => contrast(c, DARK_PANEL) < DARK_CONTRAST);
t.truthy('the light colours alone would not have stood out (why the twins are needed)', before.length > 0, before);

t.check('the same colour gives the same twin', darkColor('#3178c6'), darkColor('#3178c6'));
t.check('a TypeScript file is still known by its mark', markOf('src/main.ts')?.text, 'TS');

t.finish();
