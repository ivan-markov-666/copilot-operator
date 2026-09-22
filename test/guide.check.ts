/**
 * The pin that keeps the persona's script and the interface saying the same words.
 *
 * `src/plan/systemGuide.ts` tells the Kerrigan persona what every screen and every control of
 * this application is called, so it can say press "Create the sessions and tasks" rather than
 * "import the plan". Those labels are written out there a second time instead of being imported
 * from `web/lib/strings.ts`, because the server build has no bundler and cannot reach into the
 * Next workspace at runtime. A second copy of a string is a promise that somebody will remember
 * to change both, and nobody does — so this check is the memory. It holds every label and every
 * section heading the guide quotes against the dictionary, key by key, in English and in
 * Bulgarian, and it fails on the first character of difference.
 *
 * Which means: renaming a button in `web/lib/strings.ts` breaks this check, and the failure
 * names the key and prints both strings. That is not the check being fussy. It is the only
 * moment at which the person doing the renaming is told that a persona somewhere is about to
 * send an operator looking for a button that no longer exists. Fix the guide, keep the sentence
 * about what the control does honest, and move on. If a control disappears entirely, take its
 * entry out of the guide; if a new one is added that an operator would ever be told to press,
 * put it in.
 *
 * Matching the dictionary is not enough on its own, so two more things are held to the pages.
 * A key can be word for word right and belong to a control that no longer exists, and a label
 * the brief quotes in prose is not in the guide at all; both went stale in the same edit. So the
 * pages under `web/` are read and treated as the authority, and everything the persona quotes —
 * in the guide, and in the brief's own `**"Check it"**` — has to be the current text of something
 * on a screen.
 *
 *   npm run check:guide
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { planBrief } from '../src/plan/brief.js';
import { SYSTEM_GUIDE, systemGuideSection } from '../src/plan/systemGuide.js';
import { dict } from '../web/lib/strings.js';

const en = dict.en as Record<string, string | undefined>;
const bg = dict.bg as Record<string, string | undefined>;

type Claim = { where: string; key: string; en: string; bg: string };

const claims: Claim[] = [];
for (const screen of SYSTEM_GUIDE) {
  for (const section of screen.sections) {
    if (section.headingKey !== null) {
      claims.push({ where: `${screen.route} heading`, key: section.headingKey, en: section.en, bg: section.bg });
    }
    for (const control of section.controls) {
      claims.push({ where: `${screen.route} ${section.en}`, key: control.key, en: control.en, bg: control.bg });
    }
  }
}

const controls = SYSTEM_GUIDE.flatMap((s) => s.sections.flatMap((sec) => sec.controls));
const headings = SYSTEM_GUIDE.flatMap((s) => s.sections).filter((sec) => sec.headingKey !== null);
const unheaded = SYSTEM_GUIDE.flatMap((s) => s.sections).length - headings.length;

console.log('--- every label the guide quotes, against the dictionary ---');

let gone = 0;
let drifted = 0;

for (const claim of claims) {
  const actualEn = en[claim.key];
  const actualBg = bg[claim.key];

  // A key the guide still names but the interface no longer has: the control was renamed away
  // or removed, and the guide is now telling the operator about something that is not there.
  if (actualEn === undefined || actualBg === undefined) {
    gone += 1;
    console.log(`!! ${claim.key} — no longer in the dictionary (en: ${actualEn !== undefined}, bg: ${actualBg !== undefined})`);
    console.log(`     claimed by ${claim.where}, as "${claim.en}"`);
    continue;
  }

  if (actualEn !== claim.en) {
    drifted += 1;
    console.log(`!! ${claim.key} — the English label has changed`);
    console.log(`     guide      : ${JSON.stringify(claim.en)}`);
    console.log(`     dictionary : ${JSON.stringify(actualEn)}`);
  }
  if (actualBg !== claim.bg) {
    drifted += 1;
    console.log(`!! ${claim.key} — the Bulgarian label has changed`);
    console.log(`     guide      : ${JSON.stringify(claim.bg)}`);
    console.log(`     dictionary : ${JSON.stringify(actualBg)}`);
  }
}

console.log('labels checked            :', claims.length * 2, '(both languages)');
console.log('keys that no longer exist :', gone, '(expect 0)');
console.log('labels that have drifted  :', drifted, '(expect 0)');

console.log('\n--- what the persona is given ---');
const screens = SYSTEM_GUIDE.length;
console.log('screens described         :', screens, '| sections:', SYSTEM_GUIDE.flatMap((s) => s.sections).length, '| controls:', controls.length);
console.log('section headings pinned   :', headings.length, '| sections with no heading on screen:', unheaded);
console.log('every screen has a route  :', SYSTEM_GUIDE.every((s) => s.route.trim() !== ''), '(expect true)');
console.log('every screen has sections :', SYSTEM_GUIDE.every((s) => s.sections.length > 0), '(expect true)');
console.log('every control says what it does:', controls.every((c) => c.doesEn.trim() !== '' && c.doesBg.trim() !== ''), '(expect true)');

/*
 * The rendered section is what actually reaches the model, so the check reads it too: an entry
 * that never makes it into the Markdown is an entry nobody benefits from.
 */
console.log('\n--- the section the brief embeds ---');
const english = systemGuideSection('en');
const bulgarian = systemGuideSection('bg');
let unrendered = 0;
for (const control of controls) {
  if (!english.includes(`"${control.en}"`)) {
    unrendered += 1;
    console.log(`!! ${control.key} — the English label is not in the rendered section`);
  }
  if (!bulgarian.includes(`"${control.bg}"`)) {
    unrendered += 1;
    console.log(`!! ${control.key} — the Bulgarian label is not in the rendered section`);
  }
}
console.log('english length            :', english.length, 'chars,', english.split('\n').length, 'lines');
console.log('bulgarian length          :', bulgarian.length, 'chars,', bulgarian.split('\n').length, 'lines');
console.log('labels missing from it    :', unrendered, '(expect 0)');
console.log('names every route         :', SYSTEM_GUIDE.every((s) => english.includes(s.route) && bulgarian.includes(s.route)), '(expect true)');

console.log('\n--- the first screen, as the persona reads it ---');
console.log(english.split('\n').slice(0, 12).map((l) => '  ' + l).join('\n'));
console.log('  …');

/*
 * The two remaining ways the guide and the brief can be wrong, and both were found the same day.
 *
 * A key can still be in the dictionary, spelled exactly as the guide spells it, and yet reach no
 * screen at all: the control it belonged to was replaced and the string was simply left behind.
 * That is invisible to the checks above — the label matches, it renders into the Markdown — and
 * it is the worst kind, because the persona then names a control with total confidence and the
 * operator hunts the page for something that is not on it. It happened when the log links became
 * "save the log" buttons and three entries went on describing links that had gone.
 *
 * The brief has the same hole from the other side. Its phase scripts quote labels in prose,
 * `**"Check it"**`, and prose is not in the guide, so nothing held those quotes to anything. They
 * went stale in exactly the same edit.
 *
 * So the pages are read and treated as the authority: a key is real only if some page renders it,
 * and a label the persona quotes anywhere — in the guide or in the brief's own prose — has to be
 * the current text of one of those. A key assembled at run time, as `status.${x}` is, is matched
 * on its constant half, because the whole of it is never written down.
 */
console.log('\n--- what the pages actually render ---');

const WEB_DIRS = ['web/app', 'web/lib'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    // The dictionary itself is not a page: every key is in it by definition.
    else if (/\.tsx?$/.test(entry) && entry !== 'strings.ts') out.push(path);
  }
  return out;
}

const source = WEB_DIRS.flatMap(sourceFiles).map((f) => readFileSync(f, 'utf8')).join('\n');

/**
 * Keys written out in full, wherever they appear: `t('x')`, `fileLinks('x', …)`, a constant.
 *
 * Backticks count as quotes here and `-` counts as part of a key, because both occur: the
 * dictionary holds `status.waiting-approval` and `checks.kind.exit-zero`, and a pattern built out
 * of `\w` alone cannot see either. It passed anyway, on the accident that a nearby
 * `t(`status.${x}`)` supplied the prefix — and would have started failing the moment that one
 * template was rewritten, blaming the guide for a key the page renders perfectly well.
 */
const literal = new Set<string>();
for (const m of source.matchAll(/['"`]([a-zA-Z][\w-]*(?:\.[\w-]+)+)['"`]/g)) literal.add(m[1]);

/** Keys assembled at run time: the constant half of `t(`status.${s}`)` stands for all of them. */
const prefixes: string[] = [];
for (const m of source.matchAll(/`([^`$]*)\$\{/g)) {
  if (m[1].includes('.')) prefixes.push(m[1]);
}

const isRendered = (key: string): boolean => literal.has(key) || prefixes.some((p) => key.startsWith(p));
const renderedKeys = Object.keys(en).filter(isRendered);
console.log('keys in the dictionary    :', Object.keys(en).length, '| rendered by some page:', renderedKeys.length);

let orphaned = 0;
for (const claim of claims) {
  if (isRendered(claim.key)) continue;
  orphaned += 1;
  console.log(`!! ${claim.key} — still in the dictionary, but no page renders it`);
  console.log(`     claimed by ${claim.where}, as "${claim.en}"`);
}
console.log('keys the guide quotes     :', claims.length);
console.log('keys no page renders      :', orphaned, '(expect 0)');

/*
 * Every label the brief quotes in its own prose, against what is on a screen right now.
 *
 * The persona is told to name a control by its exact text, so the brief writes `**"Check it"**`
 * and `**„Провери“**`. Those are the sentences an operator follows, and a wrong one sends them
 * looking for a button that is not there — the whole failure this file exists to prevent, just
 * arriving through prose instead of through the guide. The brief wraps its lines, so a label can
 * be split across two of them and the whitespace is flattened before anything is compared.
 */
console.log('\n--- every label the brief quotes in prose, against the screens ---');

const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim();
let invented = 0;

for (const [lang, pattern] of [['en', /\*\*"([^"]+)"\*\*/g], ['bg', /\*\*„([^“]+)“\*\*/g]] as const) {
  const table = (lang === 'en' ? en : bg) as Record<string, string | undefined>;
  const onScreen = new Map<string, string>();
  for (const key of renderedKeys) {
    const value = table[key];
    if (value !== undefined) onScreen.set(flatten(value), key);
  }

  /*
   * Both states of the brief, because they do not carry the same text.
   *
   * With the operator's own organisation and work texts present, the brief is what somebody who
   * has already been through phase 0 copies. With them absent it carries the phase 0 interview
   * instead, and that interview quotes labels of its own — the fields the two documents are
   * pasted into, the button that copies the brief again — which appear nowhere else. Checking
   * only the settled version left exactly those labels unpinned, which is the version a first-time
   * operator never sees and every first-time operator gets.
   */
  const settled = planBrief({ lang, organisation: 'the organisation', work: 'this work' });
  const firstRun = planBrief({ lang, organisationExample: '{}', workExample: '{}' });
  const brief = `${settled}
${firstRun}`;
  const quoted = [...new Set([...brief.matchAll(pattern)].map((m) => flatten(m[1])))];
  const unknown = quoted.filter((q) => !onScreen.has(q));
  for (const q of unknown) {
    invented += 1;
    console.log(`!! the ${lang} brief quotes ${JSON.stringify(q)}, which is not on any screen`);
  }
  console.log(`${lang} labels quoted in prose  :`, quoted.length, '| not on any screen:', unknown.length, '(expect 0)');
}

const failures = gone + drifted + unrendered + orphaned + invented;
console.log('\nfailures:', failures, '(expect 0)');
if (failures > 0) {
  console.log('The interface, the guide and the brief disagree.');
  console.log('web/lib/strings.ts is the authority: fix src/plan/systemGuide.ts and src/plan/brief.ts to match it.');
  process.exit(1);
}
