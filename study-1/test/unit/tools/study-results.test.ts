// The derived Study 1 results file (close-out Phase 1): the canonical run, the within-variant
// reproductions labeled non-comparative by spec limitation 9, and the excluded validations, plus
// the command line and the spec reading that feed it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveStudyResults,
  FIELD_DEFINITIONS,
  limitationOf,
  parseDeriveArguments,
  serializeStudyResults,
} from '../../../tools/lib/study-results.ts';
import { indeterminateValidationInput, LIMITATION_9, runInput, validationInput } from './support/execution-inputs.ts';
import { InMemoryEvidence, RUN_ID, VALIDATION_ID } from './support/in-memory-evidence.ts';

const SPEC = `# CAP-RUA\n\n## Threats to Validity and Limitations\n\n1. One.\n9. ${LIMITATION_9}\n\n## Non-Goals\n\n9. Not a limitation.\n`;
const OTHER_ID = '00000000-0000-4000-8000-000000000003';
const USAGE =
  'usage: node tools/derive-study-results.ts --evidence-root <dir> --spec <spec.md> --run <id> ' +
  '[--validation <id> ...] [--excluded-validation <id> ...] --out <results.json> --readme <README.md> [--check]';
const idsRefusal = (argv: readonly string[], detail: string): { readonly message: string } => ({
  message: `${USAGE}; got ${JSON.stringify(argv)}; ${detail}`,
});

describe('deriveStudyResults', () => {
  it('places each execution by role: the canonical run, the reproductions and the excluded validations', () => {
    const results = deriveStudyResults({
      runs: [runInput(new InMemoryEvidence())],
      validations: [validationInput(new InMemoryEvidence())],
      excludedValidations: [indeterminateValidationInput(new InMemoryEvidence())],
      limitation9: LIMITATION_9,
    });
    const roles = (
      list: readonly { readonly execution_id: string; readonly role: string; readonly comparative: boolean }[],
    ): readonly (string | boolean)[][] => list.map((one) => [one.execution_id, one.role, one.comparative]);
    assert.deepEqual(
      {
        ...results,
        canonical_runs: roles(results.canonical_runs),
        within_variant_reproductions: roles(results.within_variant_reproductions),
        excluded_executions: roles(results.excluded_executions),
      },
      {
        record_type: 'study_results',
        schema_version: 1,
        capability: 'CAP-RUA',
        derived_by: 'study-1/tools/derive-study-results.ts',
        authority: "Each package's package-index.json digest is the authority; this file is a derived view.",
        field_definitions: FIELD_DEFINITIONS,
        canonical_runs: [[RUN_ID, 'canonical_run', true]],
        within_variant_reproductions: [[VALIDATION_ID, 'within_variant_reproduction', false]],
        excluded_executions: [[VALIDATION_ID, 'excluded', false]],
      },
    );
  });

  it('serializes as two-space JSON with a trailing newline, the same bytes every time', () => {
    const derive = (): string =>
      serializeStudyResults(
        deriveStudyResults({
          runs: [runInput(new InMemoryEvidence())],
          validations: [],
          excludedValidations: [],
          limitation9: LIMITATION_9,
        }),
      );
    const text = derive();
    assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    assert.equal(derive(), text);
  });
});

describe('limitationOf', () => {
  it('reads a numbered limitation from its section only', () => {
    assert.equal(limitationOf(SPEC, 9), LIMITATION_9);
    assert.equal(limitationOf(SPEC, 1), 'One.');
  });

  it('refuses a spec without the section or without the numbered item', () => {
    assert.throws(() => limitationOf(SPEC, 2), {
      message: 'the spec holds no limitation 2 under "## Threats to Validity and Limitations"; expected a line "2. …"',
    });
    assert.throws(() => limitationOf('# CAP-RUA\n9. Elsewhere.\n', 9), /holds no limitation 9/);
  });

  it('ignores a numbered line in the section that follows the limitations', () => {
    const spec =
      '# CAP-RUA\n\n## Threats to Validity and Limitations\n\n1. One.\n\n## Non-Goals\n\n9. Not a limitation.\n';
    assert.throws(() => limitationOf(spec, 9), /holds no limitation 9/);
  });
});

describe('parseDeriveArguments', () => {
  const base = [
    '--evidence-root',
    'evidence',
    '--spec',
    's.md',
    '--run',
    RUN_ID,
    '--out',
    'r.json',
    '--readme',
    'R.md',
  ];

  it('reads every flag, repeated validations, excluded validations and --check', () => {
    assert.deepEqual(
      parseDeriveArguments([
        ...base,
        '--validation',
        VALIDATION_ID,
        '--excluded-validation',
        OTHER_ID,
        '--validation',
        '00000000-0000-4000-8000-000000000004',
        '--check',
      ]),
      {
        evidenceRoot: 'evidence',
        spec: 's.md',
        runs: [RUN_ID],
        validations: [VALIDATION_ID, '00000000-0000-4000-8000-000000000004'],
        excludedValidations: [OTHER_ID],
        out: 'r.json',
        readme: 'R.md',
        check: true,
      },
    );
    const plain = parseDeriveArguments(base);
    assert.deepEqual([plain.validations, plain.excludedValidations, plain.check], [[], [], false]);
  });

  it('refuses an unknown flag, a missing value, a repeated or absent single flag, no run, a malformed or repeated id', () => {
    const usage = /^Error: usage: node tools\/derive-study-results\.ts /;
    for (const argv of [
      [...base, '--other', 'x'],
      [...base, '--out'],
      [...base, '--spec', '--check'],
      [...base, '--out', 'again.json'],
      base.slice(2),
      ['--evidence-root', 'evidence', '--spec', 's.md', '--out', 'r.json'],
      [...base, '--validation', '../runs/x'],
      [...base, '--excluded-validation', 'ABCDEF00-0000-4000-8000-000000000001'],
      [...base, '--validation', OTHER_ID, '--excluded-validation', OTHER_ID],
      [...base, '--validation', RUN_ID],
    ]) {
      assert.throws(() => parseDeriveArguments(argv), usage, JSON.stringify(argv));
    }
    assert.throws(() => parseDeriveArguments([...base, '--out', 'again.json']), /with 2 --out$/);
    assert.throws(() => parseDeriveArguments(base.slice(0, -2)), /with 0 --readme$/);
    const twice = [...base, '--run', RUN_ID];
    assert.throws(
      () => parseDeriveArguments(twice),
      idsRefusal(twice, `got repeated ids ["${RUN_ID}"]; expected each id once`),
    );
  });

  it('names why the ids are refused: no run, the malformed ids, or the repeated ids', () => {
    const noRun = ['--evidence-root', 'evidence', '--spec', 's.md', '--out', 'r.json'];
    assert.throws(() => parseDeriveArguments(noRun), idsRefusal(noRun, 'expected at least one --run'));
    const upper = 'ABCDEF00-0000-4000-8000-000000000001';
    const malformed = [...base, '--validation', '../runs/x', '--excluded-validation', upper];
    assert.throws(
      () => parseDeriveArguments(malformed),
      idsRefusal(malformed, `got malformed ids ["../runs/x","${upper}"]; expected lowercase UUID ids`),
    );
    const repeated = [...base, '--validation', OTHER_ID, '--excluded-validation', OTHER_ID, '--validation', RUN_ID];
    assert.throws(
      () => parseDeriveArguments(repeated),
      idsRefusal(repeated, `got repeated ids ["${RUN_ID}","${OTHER_ID}"]; expected each id once`),
    );
  });

  it('states the full usage when a flag is followed by another flag instead of its value', () => {
    const argv = [...base, '--spec', '--check'];
    assert.throws(() => parseDeriveArguments(argv), { message: `${USAGE}; got ${JSON.stringify(argv)}` });
  });

  it('refuses an id with anything before or after the UUID, such as a ../ prefix', () => {
    for (const id of [`../${VALIDATION_ID}`, `x${VALIDATION_ID}`, `${VALIDATION_ID}/..`, `${VALIDATION_ID}x`]) {
      const argv = [...base, '--validation', id];
      assert.throws(
        () => parseDeriveArguments(argv),
        idsRefusal(argv, `got malformed ids ${JSON.stringify([id])}; expected lowercase UUID ids`),
      );
    }
  });
});

describe('FIELD_DEFINITIONS', () => {
  it('defines every field in words', () => {
    assert.deepEqual(FIELD_DEFINITIONS, {
      paths:
        'Every artifact path is relative to its package directory; package and verification paths are relative to the evidence root.',
      package_index_sha256: "SHA-256 of the package's package-index.json bytes: the package's identity.",
      'safety.estimated_cost': "The safety assessment's pre-billing cost estimate (BR-RUA-046), not billed cost.",
      'safety.active_time': "The safety assessment's observed active time against its declared limit.",
      'trials[].preservation_verdict': "The frozen oracle result's verdict on the single-refund invariant.",
      'trials[].successful_transaction_count':
        'SUCCEEDED transactions in the frozen ledger snapshot, cross-checked with the oracle.',
      'trials[].refunded_total_minor': 'Sum of amount_minor over those transactions, in minor units of currency.',
      'trials[].commit_gap_seconds':
        'Seconds from the first to the second commit_requested_at; null with fewer than two commits.',
      'trials[].retry.source_receive_count': 'Highest approximate_receive_count over the caller journal invocations.',
      'trials[].retry.durable_step_attempt':
        'Highest step_attempt over the caller journal invocations; null for a conventional caller.',
      'trials[].retry.durable_executions':
        'Each Durable execution: its status, last history event and highest step attempt.',
      'trials[].retry.mechanism':
        'source_redelivery when receive count > 1; durable_step_retry when step attempt > 1; both or none.',
      within_variant_reproductions:
        'Variant validations: one variant each, never comparative (spec limitation 9). A variant validation is a within-variant reproduction only when its summary states implementation_validation_status verified and validation_validity valid.',
      excluded_executions:
        'Variant validations that fail that criterion: never counted, listed with the status reasons, unverified gates and indeterminate reason codes their own packages state.',
    });
  });
});
