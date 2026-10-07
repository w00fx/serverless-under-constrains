// The study block of the root README's "Repository status" (close-out, the owner's item 4): every
// value it states is read from the derived results, and it replaces only the text between its two
// marker lines.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { ExecutionResult } from '../../../tools/lib/study-results-execution.ts';
import {
  repositoryStatus,
  STATUS_BEGIN,
  STATUS_END,
  withRepositoryStatus,
} from '../../../tools/lib/study-results-status.ts';
import type { TrialResult } from '../../../tools/lib/study-results-trial.ts';
import type { StudyResults } from '../../../tools/lib/study-results.ts';
import { deriveStudyResults } from '../../../tools/lib/study-results.ts';
import { indeterminateValidationInput, LIMITATION_9, runInput, validationInput } from './support/execution-inputs.ts';
import { InMemoryEvidence } from './support/in-memory-evidence.ts';

function fixtureResults(): StudyResults {
  return deriveStudyResults({
    runs: [runInput(new InMemoryEvidence())],
    validations: [validationInput(new InMemoryEvidence())],
    excludedValidations: [indeterminateValidationInput(new InMemoryEvidence())],
    limitation9: LIMITATION_9,
  });
}

function onlyRun(results: StudyResults): ExecutionResult {
  const [run] = results.canonical_runs;
  assert.ok(run !== undefined);
  return run;
}

describe('repositoryStatus', () => {
  it('states the canonical run, its trials, the reproductions and the exclusions from the results', () => {
    assert.equal(
      repositoryStatus(fixtureResults()),
      [
        'Every value in this block is read from [`results/study-1/results.json`](results/study-1/results.json).',
        '',
        'The canonical run `00000000` ran 2 trials from source commit `ccccccc`, qualified by transport probe ' +
          '`00000000`; refund commit dates (UTC): 2026-10-07. 2 of the 2 trials were valid. Outcome: ' +
          'run_terminal_reason `COMPLETED`, execution_status `completed`, comparison_eligibility `eligible`. ' +
          'Closure: cleanup_status `succeeded`, leak_audit_status `clean`, lease_status `released`, ' +
          'safety_status `within_limits`, evidence_integrity_status `verified`.',
        '',
        '| Trial | Scenario | Variant | Successful provider transactions | Refunded, in minor units | Preservation verdict |',
        '|---|---|---|---|---|---|',
        '| 1 | `CONTROL` | `conventional` | 1 | 10000 BRL | `pass` |',
        '| 2 | `COMMIT_THEN_TIMEOUT` | `durable` | 2 | 20000 BRL | `fail` |',
        '',
        'Within-variant reproductions, never comparative: `00000000` (`durable`): `COMMIT_THEN_TIMEOUT` `fail`.',
        '',
        'Excluded by the reproduction criterion: `00000000` (`durable`): validation_terminal_reason `COMPLETED`, ' +
          'implementation_validation_status `indeterminate`, validation_validity `indeterminate`.',
        '',
      ].join('\n'),
    );
  });

  it('lists the commit dates sorted once each, counts only valid trials, and omits a missing currency', () => {
    const results = fixtureResults();
    const run = onlyRun(results);
    const [control, timeout] = run.trials;
    assert.ok(control !== undefined && timeout !== undefined);
    const empty: TrialResult = {
      ...control,
      sequence: 3,
      trial_validity: 'invalid',
      successful_transaction_count: 0,
      refunded_total_minor: '0',
      currency: null,
      commit_times: [],
    };
    const later: TrialResult = {
      ...timeout,
      commit_times: ['2026-10-09T00:00:00.000Z', '2026-10-08T23:59:59.999Z'] as UtcMillis[],
    };
    const text = repositoryStatus({ ...results, canonical_runs: [{ ...run, trials: [later, control, empty] }] });
    assert.match(
      text,
      /; refund commit dates \(UTC\): 2026-10-07, 2026-10-08, 2026-10-09\. 2 of the 3 trials were valid\./,
    );
    assert.match(text, /\n\| 3 \| `CONTROL` \| `conventional` \| 0 \| 0 \| `pass` \|\n/);
  });

  it('states none for a run without commits, and without reproductions or exclusions', () => {
    const results = fixtureResults();
    const run = onlyRun(results);
    const text = repositoryStatus({
      ...results,
      canonical_runs: [{ ...run, trials: run.trials.map((trial) => ({ ...trial, commit_times: [] })) }],
      within_variant_reproductions: [],
      excluded_executions: [],
    });
    assert.match(text, /; refund commit dates \(UTC\): none\. /);
    assert.match(
      text,
      /\nWithin-variant reproductions, never comparative: none\.\n\nExcluded by the reproduction criterion: none\.\n$/,
    );
  });

  it('names each variant of an execution once, and separates executions with semicolons', () => {
    const results = fixtureResults();
    const run = onlyRun(results);
    const [control] = run.trials;
    assert.ok(control !== undefined);
    const text = repositoryStatus({
      ...results,
      within_variant_reproductions: [
        { ...run, execution_id: 'a1b2c3d4-0000-4000-8000-000000000001', trials: [...run.trials, control] },
        { ...run, execution_id: 'e5f6a7b8-0000-4000-8000-000000000002', trials: [control] },
      ],
      excluded_executions: [
        ...results.excluded_executions,
        ...results.excluded_executions.map((one) => ({ ...one, execution_id: 'f0e1d2c3-0000-4000-8000-000000000003' })),
      ],
    });
    assert.match(
      text,
      new RegExp(
        'reproductions, never comparative: `a1b2c3d4` \\(`conventional`, `durable`\\): `CONTROL` `pass`, ' +
          '`COMMIT_THEN_TIMEOUT` `fail`, `CONTROL` `pass`; `e5f6a7b8` \\(`conventional`\\): `CONTROL` `pass`\\.\\n',
      ),
    );
    assert.match(text, /validation_validity `indeterminate`; `f0e1d2c3` \(`durable`\): validation_terminal_reason /);
  });
});

describe('withRepositoryStatus', () => {
  const readme = `# Title\n\nBefore.\n\n${STATUS_BEGIN}\nold line\n\nold table\n${STATUS_END}\n\nAfter.\n`;

  it('replaces only the text between the marker lines', () => {
    assert.equal(
      withRepositoryStatus(readme, 'new line\n'),
      `# Title\n\nBefore.\n\n${STATUS_BEGIN}\nnew line\n${STATUS_END}\n\nAfter.\n`,
    );
    assert.equal(
      withRepositoryStatus(`${STATUS_BEGIN}\n${STATUS_END}\n`, 'filled\n'),
      `${STATUS_BEGIN}\nfilled\n${STATUS_END}\n`,
    );
  });

  it('refuses a README without exactly one begin marker before exactly one end marker', () => {
    const refusal = (begins: number, ends: number): { readonly message: string } => ({
      message:
        `the README holds ${String(begins)} begin and ${String(ends)} end study-results markers; ` +
        `expected one "${STATUS_BEGIN}" line before one "${STATUS_END}" line`,
    });
    for (const [text, begins, ends] of [
      ['# Title\n', 0, 0],
      [`${STATUS_BEGIN}\n`, 1, 0],
      [`${STATUS_END}\n`, 0, 1],
      [`${STATUS_BEGIN}\n${STATUS_BEGIN}\n${STATUS_END}\n`, 2, 1],
      [`${STATUS_BEGIN}\n${STATUS_END}\n${STATUS_END}\n`, 1, 2],
      [`${STATUS_END}\nmiddle\n${STATUS_BEGIN}\n`, 1, 1],
    ] as const) {
      assert.throws(() => withRepositoryStatus(text, 'x\n'), refusal(begins, ends), text);
    }
  });

  it('marks the block as generated from the results file', () => {
    assert.equal(
      STATUS_BEGIN,
      '<!-- study-results:begin; generated by `npm run results` in study-1/ from results/study-1/results.json, do not edit -->',
    );
    assert.equal(STATUS_END, '<!-- study-results:end -->');
  });
});
