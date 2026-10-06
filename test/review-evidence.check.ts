/**
 * Review findings are not closed by lexical self-attestation checks (operator's feedback, 2026-10-06).
 *
 * A check given with a finding must test the primary evidence — an artifact, a JSON envelope, a
 * correlation ID in telemetry, a probe that runs, a symbol and path that exist — not that a text says
 * "proved", "derived", "verified", "Activity" or "complete". Such a check is not kept; the finding stays
 * a finding. And the next reviewer is given each earlier finding with its evidence, what its check came
 * to, and the implementer's account of the correction.
 *
 *   npm run check:review-evidence
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selfAttestationReason, validateDerivedChecks } from '../src/orchestrator/derivedChecks.js';
import { reviewBrief } from '../src/orchestrator/review.js';
import type { TaskCheck } from '../src/session/model.js';
import { Tally } from './support/harness.js';

const t = new Tally();
const c = (x: Partial<TaskCheck>): TaskCheck => ({ name: 'x', expect: 'file-contains', ...x }) as TaskCheck;

console.log('--- which checks are lexical self-attestation ---');
{
  const lexical = [
    c({ file: 'docs/report.md', value: 'proved' }),
    c({ file: 'out/summary.txt', value: 'Activity' }),
    c({ file: 'README.md', value: 'bill_type is derived' }),
    c({ file: 'docs/apz.md', value: 'verified and complete' }),
    c({ expect: 'output-contains', run: 'Get-Content docs/report.md', value: 'derived' }),
    c({ expect: 'output-matches', run: 'Select-String -Path docs/*.md -Pattern verified', value: 'verified' }),
  ];
  t.check('text that can simply say the word: not kept', lexical.map((x) => selfAttestationReason(x) !== null), lexical.map(() => true));

  const evidence = [
    c({ file: 'out/result.json', value: '"status": "complete"' }),
    c({ file: 'logs/telemetry.jsonl', value: 'correlationId' }),
    c({ file: 'src/rules/billType.ts', value: 'export function deriveBillType' }),
    c({ expect: 'output-contains', run: 'node scripts/probe.mjs', value: 'complete' }),
    c({ expect: 'output-contains', run: 'node --test', value: 'pass 3' }),
    c({ expect: 'file-exists', file: 'out/result.json' }),
    c({ expect: 'exit-zero', run: 'node scripts/probe.mjs' }),
  ];
  t.check('structure, identifiers, probes and artifacts: kept', evidence.map((x) => selfAttestationReason(x)), evidence.map(() => null));
}

console.log('\n--- a finding whose check is lexical stays a finding, and the check never runs ---');
{
  const dir = mkdtempSync(join(tmpdir(), 'cop-evidence-'));
  try {
    const finding = (id: string, check: TaskCheck) => ({ id, what: 'the claim is not shown', evidence: 'no artifact', basis: 'b', where: 'docs/report.md', about: 'work' as const, check });
    const v = await validateDerivedChecks(
      [
        finding('r1f1', c({ name: 'report says proved', file: 'docs/report.md', value: 'proved' })),
        finding('r1f2', c({ name: 'the output artifact exists', expect: 'file-exists', file: 'out/result.json' })),
      ],
      { cwd: dir, logDir: join(dir, 'logs') },
    );
    t.check('the lexical one is set apart, with why', [v.lexical.map((l) => l.finding.id), /text can simply say/.test(v.lexical[0]?.why ?? '')], [['r1f1'], true]);
    t.check('the evidence one is run and kept (it fails on the work as it is)', v.kept.map((k) => k.finding.id), ['r1f2']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n--- the next reviewer gets each finding, its evidence, its check\'s result and the correction ---');
{
  const brief = reviewBrief(
    { vcs: { enabled: false } } as never,
    { prompt: 'Make the APZ bill type derivation observable.', level2: '', title: 't' } as never,
    [],
    'C:\\x',
    [],
    {
      round: 1,
      findings: [
        { id: 'r1f1', what: 'The report claims bill_type is derived but shows no output', evidence: 'out/result.json does not exist', basis: 'b', where: 'docs/report.md', about: 'work' },
        { id: 'r1f2', what: 'No telemetry for the rule', evidence: 'telemetry has no correlation ID', basis: 'b', where: 'logs/telemetry.jsonl', about: 'work' },
      ],
      correction: 'Added the derivation and wrote "proved" in the report.',
      evidenceChecks: [{ findingId: 'r1f2', name: 'review r1f2: telemetry has the correlation ID', state: 'active', passed: false, detail: 'correlationId not found' }],
    },
  );
  t.truthy('the evidence each finding rested on', brief.includes('Evidence then: out/result.json does not exist') && brief.includes('Evidence then: telemetry has no correlation ID'), brief);
  t.truthy("a finding's check and what it came to at the last gate", brief.includes('Its check "review r1f2: telemetry has the correlation ID": FAILED at the last gate — correlationId not found'), brief);
  t.truthy('a finding with no machine check is said to be judged on the evidence', brief.includes('No machine check: judge it on the evidence yourself.'), brief);
  t.truthy("the implementer's correction, as a claim", brief.includes("The implementer's account of what it corrected (a claim; test it, do not take it):") && brief.includes('wrote "proved" in the report'), brief);
  t.truthy('and that a word in the text resolves nothing', /never because the text now says "proved",\s+"verified", "derived" or "complete"/.test(brief), brief);
}

t.finish();
