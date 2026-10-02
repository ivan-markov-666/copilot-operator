/**
 * The script that puts the reader's appearance on `<html>` before the first paint, and the two
 * facts it shares with the Appearance settings: where they are stored and which text sizes exist.
 *
 * This module has no 'use client' on purpose, and must never get one. The root layout is a server
 * component, and a value it imports from a 'use client' module is not the value in the page's data:
 * it is a reference to that module, which the browser resolves only once the module's chunk has
 * loaded. That is what happened when this lived in appearance.tsx. The script's text in `<head>`
 * waited on the layout's chunk, React paused there while hydrating, and when it resumed it lost its
 * place: the first element of `<body>` was compared with the first one of `<head>`, the hydration
 * failed (React error #418), and the whole page was thrown away and drawn again, on whichever load
 * the chunk happened to arrive late. A value imported from here reaches the page as the text itself.
 * test/ui.check.ts checks the built pages for any such reference in `<head>`.
 */

export const APPEARANCE_STORAGE_KEY = 'cop.appearance';

/**
 * The text sizes, smallest first: one step below normal and three above it.
 *
 * The names are what is stored, so they never change meaning: `large` and `huge` were the only two
 * steps above normal until 2026-09-29 and a browser that saved one of them must still land on the
 * same size. New steps got new names (`small`, `giant`) rather than renumbering the old ones. The
 * factor for each lives in globals.css, beside the rest of the scale.
 */
export const TEXT_SIZES = ['small', 'normal', 'large', 'huge', 'giant'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

/**
 * Runs before React, inline in the document head. Anything it cannot do — bad json, no
 * storage — leaves the defaults in the markup, which are already correct.
 */
export const themeScript = `
(function () {
  try {
    var d = document.documentElement;
    var raw = localStorage.getItem('${APPEARANCE_STORAGE_KEY}');
    var a = raw ? JSON.parse(raw) : {};
    if (!a || typeof a !== 'object') a = {};
    d.dataset.theme = a.theme === 'dark' ? 'dark' : 'light';
    d.dataset.textsize = ${JSON.stringify(TEXT_SIZES)}.indexOf(a.textSize) >= 0 ? a.textSize : 'normal';
    d.dataset.contrast = a.highContrast ? 'high' : 'normal';
    d.dataset.motion = a.reduceMotion ? 'reduced' : 'normal';
    d.dataset.links = a.underlineLinks ? 'underline' : 'plain';
    d.dataset.focus = a.strongFocus ? 'strong' : 'normal';
  } catch (e) {}
})();
`;
