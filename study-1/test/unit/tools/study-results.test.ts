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
});

describe('parseDeriveArguments', () => {
  const base = ['--evidence-root', 'evidence', '--spec', 's.md', '--run', RUN_ID, '--out', 'r.json'];

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
    assert.throws(() => parseDeriveArguments([...base, '--run', RUN_ID]), /distinct lowercase UUID ids$/);
  });
});
