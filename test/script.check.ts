/**
 * Kerrigan's questions are the same every time: word for word, in order, numbered in digits.
 *
 * The same brief pasted into three new conversations came back with three different opening menus —
 * one lettered its questions A, B, C, two numbered them, one asked about the persona and two did not.
 * The fix is `src/plan/script.ts`: every message that asks the operator anything is data, printed
 * into the brief as a quotation to be copied. What this file pins is the part a model cannot fix and
 * an edit can quietly break:
 *
 *   the numbering     questions 1, 2, 3; options under question n are n.1, n.2 …; a message with one
 *                     choice numbers its options 1, 2 …; no letter anywhere a number is expected
 *   the languages     English and Bulgarian render the same numbers, message by message
 *   the states        the first-run interview only while nothing is written, the persona step only
 *                     while it is the one thing missing, the rest always
 *   the projects      offered as the machine's own list, in order, with "another folder" last
 *   the old rule      the brief no longer tells the model to letter anything
 */
import { planBrief, type KnownProject } from '../src/plan/brief.js';
import { SCRIPT, renderMessage, PHASE_LINES, ON_RECORD_ALL, ON_RECORD_MIXED, OPENING } from '../src/plan/script.js';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const PROJECTS: KnownProject[] = [
  { name: '', rootDir: 'C:\\Projects\\rules-tests', repo: true, isDefault: true },
  { name: 'rules-api', rootDir: 'C:/Projects/rules-api', repo: true, isDefault: false },
  { name: 'calculator-test', rootDir: 'C:/Projects/calculator-test', repo: true, isDefault: false },
];

/**
 * The numbering of one rendered message, as tokens: `Q1`, `O1.1`, `S1` (an option of a single
 * choice). Also returns every problem found, so a failure names the line rather than a count.
 */
function numbering(lines: string[]): { tokens: string[]; problems: string[] } {
  const tokens: string[] = [];
  const problems: string[] = [];
  let question = 0;
  let option = 0;
  for (const line of lines) {
    // A letter used as a label, at the start of a line or of a list item: "А.", "B)", "- В1".
    if (/^\s*(?:-\s*)?[A-Za-zА-Яа-я][.)]\s/.test(line) || /^\s*(?:-\s*)?[A-Za-zА-Яа-я]\d\b/.test(line)) {
      problems.push(`a letter as a label: ${line}`);
    }
    const q = /^(\d+)\. /.exec(line);
    const o = /^ {3}- (\d+)\.(\d+) /.exec(line);
    if (o) {
      const [n, j] = [Number(o[1]), Number(o[2])];
      if (n !== question) problems.push(`option ${n}.${j} under question ${question}: ${line}`);
      if (j !== option + 1) problems.push(`option ${n}.${j} after ${n}.${option}: ${line}`);
      option = j;
      tokens.push(`O${n}.${j}`);
    } else if (q) {
      const n = Number(q[1]);
      tokens.push(`Q${n}`);
      question = n;
      option = 0;
    } else if (/^\s+-?\s*\d/.test(line)) {
      problems.push(`an indented number in no known shape: ${line}`);
    }
  }
  return { tokens, problems };
}

console.log('--- every message: digits only, options under their question, in order ---');
for (const m of SCRIPT) {
  const byLang: Record<string, string[]> = {};
  for (const lang of ['en', 'bg'] as const) {
    const lines = renderMessage(m, PROJECTS, lang).filter((l) => !m.lead?.some((x) => x[lang] === l));
    const { tokens, problems } = numbering(lines);
    for (const p of problems) console.log(`   ${lang} ${m.id}: ${p}`);
    check(`${lang} ${m.id}: numbering is sound`, problems.length, 0);
    // Questions count up from 1 without a gap.
    const qs = tokens.filter((t) => t.startsWith('Q')).map((t) => Number(t.slice(1)));
    const single = m.questions.length === 1 && 'choose' in m.questions[0]!;
    if (!single) check(`${lang} ${m.id}: questions are 1..${m.questions.length}`, qs.join(','), m.questions.map((_, i) => i + 1).join(','));
    byLang[lang] = tokens;
  }
  check(`${m.id}: English and Bulgarian number alike`, byLang.en!.join(' '), byLang.bg!.join(' '));
  // A hint straight under a line is, to Markdown, the end of that line: it needs a blank line first.
  for (const lang of ['en', 'bg'] as const) {
    const lines = renderMessage(m, PROJECTS, lang);
    const glued = lines.filter((l, i) => l.startsWith('   *') && lines[i - 1] !== '').length;
    check(`${lang} ${m.id}: every hint is a paragraph of its own`, glued, 0);
  }
}

console.log('\n--- a message with one choice numbers its options 1, 2 ---');
{
  const persona = SCRIPT.find((m) => m.id === 'persona-ask')!;
  const bg = renderMessage(persona, PROJECTS, 'bg');
  check('persona: option 1 as the operator wrote it', bg.includes('1. Имам персона и ще я предоставя в следващото си чат съобщение, за да я валидираш.'), true);
  check('persona: option 2 as the operator wrote it', bg.includes('2. Нямам персона и искам да ми помогнеш да я създадем.'), true);
  check('persona: no third option', bg.some((l) => l.startsWith('3. ')), false);
  check('persona: no "something else"', bg.some((l) => l.includes('друго')), false);
}

console.log('\n--- the project questions offer the machine\'s own list ---');
{
  const first = SCRIPT.find((m) => m.id === 'org-work')!;
  const bg = renderMessage(first, PROJECTS, 'bg');
  check('4.1 is the default project', bg.some((l) => l === '   - 4.1 проектът по подразбиране — `C:\\Projects\\rules-tests`'), true);
  check('4.3 is the third listed', bg.some((l) => l === '   - 4.3 calculator-test — `C:/Projects/calculator-test`'), true);
  check('4.4 is another folder, last', bg.some((l) => l === '   - 4.4 друга папка — напиши абсолютния ѝ път'), true);
  check('and there is no 4.5', bg.some((l) => l.includes('4.5')), false);
}

console.log('\n--- each state of the brief carries the messages it can reach ---');
const QUOTED_OPENING: Record<'en' | 'bg', string> = {
  en: '> 1. Where does work come from',
  bg: '> 1. Откъде идва работата',
};
const QUOTED_PERSONA: Record<'en' | 'bg', string> = {
  en: '> 1. I have a persona',
  bg: '> 1. Имам персона',
};
const QUOTED_PHASE1: Record<'en' | 'bg', string> = {
  en: '> 1. The assignment: paste it',
  bg: '> 1. Заданието: постави го',
};
for (const lang of ['en', 'bg'] as const) {
  const firstRun = planBrief({ lang, projects: PROJECTS, organisationExample: '{}', personaExample: '{}', workExample: '{}' });
  const personaMissing = planBrief({ lang, projects: PROJECTS, organisation: 'org', personaExample: '{}', work: 'work' });
  const settled = planBrief({ lang, projects: PROJECTS, organisation: 'org', persona: 'approach', work: 'work' });

  check(`${lang}, first run: the phase 0 opening`, firstRun.includes(QUOTED_OPENING[lang]), true);
  check(`${lang}, first run: the persona question`, firstRun.includes(QUOTED_PERSONA[lang]), true);
  check(`${lang}, persona missing: no phase 0 opening`, personaMissing.includes(QUOTED_OPENING[lang]), false);
  check(`${lang}, persona missing: the persona question`, personaMissing.includes(QUOTED_PERSONA[lang]), true);
  check(`${lang}, settled: neither`, settled.includes(QUOTED_OPENING[lang]) || settled.includes(QUOTED_PERSONA[lang]), false);
  for (const [state, b] of [['first run', firstRun], ['persona missing', personaMissing], ['settled', settled]] as const) {
    check(`${lang}, ${state}: the phase 1 opening`, b.includes(QUOTED_PHASE1[lang]), true);
    check(`${lang}, ${state}: the same brief twice is the same text`, b === planBrief(
      state === 'first run'
        ? { lang, projects: PROJECTS, organisationExample: '{}', personaExample: '{}', workExample: '{}' }
        : state === 'persona missing'
          ? { lang, projects: PROJECTS, organisation: 'org', personaExample: '{}', work: 'work' }
          : { lang, projects: PROJECTS, organisation: 'org', persona: 'approach', work: 'work' },
    ), true);
    // A phase line copied from a section heading, and no fixed way to answer what is already known.
    check(`${lang}, ${state}: phase 1 messages open with the phase 1 line`, b.includes(`> ${PHASE_LINES.p1[lang]}\n>\n> 1.`), true);
    check(`${lang}, ${state}: the all-known ending is given`, b.includes(ON_RECORD_ALL[lang]), true);
    check(`${lang}, ${state}: and the mixed one`, b.includes(ON_RECORD_MIXED[lang]), true);
    // "Already said" once showed the ticket's title alone, which the operator cannot confirm as the assignment.
    check(`${lang}, ${state}: already said is the whole answer`, b.includes(lang === 'bg' ? 'Отговорът е целият, не етикет' : 'The\n  answer is the whole of it, not a label'), true);
    // Unfilled braces went out once, in a message about a run that did not exist.
    check(`${lang}, ${state}: unfilled braces are never sent`, b.includes(lang === 'bg' ? 'непопълнени {скоби} не се изпраща никога' : 'unfilled {braces} is never sent'), true);
    // The rule that produced "А1 Б2" is gone, in both spellings.
    check(`${lang}, ${state}: nothing tells it to letter questions`, /А, Б, В|A, B, C|А1 Б2|A1 B2/.test(b), false);
  }
}

/*
 * Where the conversation starts is decided by the brief's state, not by the model. With every document
 * written, one conversation opened from phase 3 with two greetings glued together; now each state
 * carries exactly one greeting, and it is the only greeting the brief contains.
 */
console.log('\n--- each state opens one way ---');
for (const lang of ['en', 'bg'] as const) {
  const states = {
    phase0: planBrief({ lang, projects: PROJECTS, organisationExample: '{}', personaExample: '{}', workExample: '{}' }),
    persona: planBrief({ lang, projects: PROJECTS, organisation: 'org', personaExample: '{}', work: 'work' }),
    phase1: planBrief({ lang, projects: PROJECTS, organisation: 'org', persona: 'approach', work: 'work' }),
  } as const;
  for (const [state, b] of Object.entries(states) as Array<[keyof typeof OPENING, string]>) {
    const own = OPENING[state].greeting[lang];
    check(`${lang}, ${state}: its own greeting`, b.includes(`> ${own}`), true);
    const others = (Object.keys(OPENING) as Array<keyof typeof OPENING>).filter((s) => s !== state);
    check(`${lang}, ${state}: and no other`, others.some((s) => b.includes(OPENING[s].greeting[lang])), false);
    check(`${lang}, ${state}: phases 3 and 4 wait for a run`, b.includes(lang === 'bg' ? 'Фаза 3 и фаза 4 започват само когато' : 'Phases 3 and 4 begin only when'), true);
  }
  // The whole first message is written out, greeting first: once the phase line came out above it.
  for (const [state, b] of Object.entries(states) as Array<[keyof typeof OPENING, string]>) {
    const phase = state === 'phase0' ? PHASE_LINES.p0 : state === 'persona' ? PHASE_LINES.beforeP1 : PHASE_LINES.p1;
    check(`${lang}, ${state}: greeting, then the phase line`, b.includes(`> ${OPENING[state].greeting[lang]}\n>\n> ${phase[lang]}`), true);
  }
  // The persona messages belong to phase 0 inside the interview, and to "before phase 1" on their own.
  const persona = SCRIPT.find((m) => m.id === 'persona-build-approach')!;
  check(`${lang}: persona in the interview opens as phase 0`, renderMessage(persona, PROJECTS, lang, ['phase0', 'phase1'])[0], PHASE_LINES.p0[lang]);
  check(`${lang}: persona on its own opens as before phase 1`, renderMessage(persona, PROJECTS, lang, ['persona', 'phase1'])[0], PHASE_LINES.beforeP1[lang]);
}

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
