// The derived Study 1 results file (close-out Phase 1): the canonical run and the variant
// validations, each read from its package and its verify outputs, the validations labeled
// non-comparative by spec limitation 9.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ExecutionInput, LooseFile, VerificationResult } from '../../../tools/lib/study-results.ts';
import {
  deriveExecutionResult,
  deriveStudyResults,
  FIELD_DEFINITIONS,
  limitationOf,
  parseDeriveArguments,
  serializeStudyResults,
} from '../../../tools/lib/study-results.ts';
import type { EditableRecord, FileMap } from './support/in-memory-evidence.ts';
import {
  bytesOf,
  COMMIT,
  CONTROL_CONVENTIONAL,
  digestOf,
  executionFiles,
  InMemoryEvidence,
  PROBE_ID,
  PROBE_INDEX,
  editableIn,
  firstOf,
  RUN_ID,
  TIMEOUT_DURABLE,
  VALIDATION_ID,
} from './support/in-memory-evidence.ts';

const LIMITATION_9 =
  'Variant-validation evidence is non-comparative and cannot substitute for the canonical four-cell run.';
const SPEC = `# CAP-RUA\n\n## Threats to Validity and Limitations\n\n1. One.\n9. ${LIMITATION_9}\n\n## Non-Goals\n\n9. Not a limitation.\n`;
const RUN_DIRECTORY = `runs/${RUN_ID}`;
const VALIDATION_DIRECTORY = `variant-validations/${VALIDATION_ID}`;

function verificationOf(id: string, record: EditableRecord): LooseFile {
  return {
    path: `verifications/${id}/2026-10-07T06:00:00.000Z-${String(record['record_type'])}.json`,
    bytes: bytesOf(record),
  };
}

function runInput(
  evidence: InMemoryEvidence,
  verifications: (index: string) => readonly LooseFile[] = () => [],
): ExecutionInput {
  evidence.putPackage(RUN_DIRECTORY, executionFiles('run', RUN_ID, [CONTROL_CONVENTIONAL, TIMEOUT_DURABLE]));
  return {
    kind: 'run',
    id: RUN_ID,
    read: evidence.read,
    verifications: verifications(evidence.indexDigest(RUN_DIRECTORY)),
  };
}

function editedRun(change: (files: FileMap) => void): ExecutionInput {
  const evidence = new InMemoryEvidence();
  const files = executionFiles('run', RUN_ID, [CONTROL_CONVENTIONAL]);
  change(files);
  evidence.putPackage(RUN_DIRECTORY, files);
  return { kind: 'run', id: RUN_ID, read: evidence.read, verifications: [] };
}

function summaryEdit(change: (summary: EditableRecord) => void): (files: FileMap) => void {
  return (files) => {
    const summary = editableIn(files, 'summary/run-summary.json');
    change(summary);
    files.set('summary/run-summary.json', summary);
  };
}

describe('deriveStudyResults', () => {
  it('splits the canonical run from the within-variant reproductions and labels only these non-comparative', () => {
    const evidence = new InMemoryEvidence();
    evidence.putPackage(VALIDATION_DIRECTORY, executionFiles('variant_validation', VALIDATION_ID, [TIMEOUT_DURABLE]));
    const validation: ExecutionInput = {
      kind: 'variant_validation',
      id: VALIDATION_ID,
      read: evidence.read,
      verifications: [],
    };
    const results = deriveStudyResults([validation, runInput(evidence)], LIMITATION_9);
    assert.deepEqual(
      {
        ...results,
        canonical_runs: results.canonical_runs.map((one) => [
          one.execution_id,
          one.role,
          one.comparative,
          one.non_comparative_basis,
        ]),
        within_variant_reproductions: results.within_variant_reproductions.map((one) => [
          one.execution_id,
          one.role,
          one.comparative,
          one.non_comparative_basis,
        ]),
      },
      {
        record_type: 'study_results',
        schema_version: 1,
        capability: 'CAP-RUA',
        derived_by: 'study-1/tools/derive-study-results.ts',
        authority: "Each package's package-index.json digest is the authority; this file is a derived view.",
        field_definitions: FIELD_DEFINITIONS,
        canonical_runs: [[RUN_ID, 'canonical_run', true, null]],
        within_variant_reproductions: [
          [VALIDATION_ID, 'within_variant_reproduction', false, `Spec limitation 9: ${LIMITATION_9}`],
        ],
      },
    );
    const [reproduction] = results.within_variant_reproductions;
    assert.deepEqual(reproduction?.outcome, {
      validation_terminal_reason: 'COMPLETED',
      implementation_validation_status: 'verified',
      validation_validity: 'valid',
    });
  });

  it('serializes as two-space JSON with a trailing newline, the same bytes every time', () => {
    const results = deriveStudyResults([runInput(new InMemoryEvidence())], LIMITATION_9);
    const text = serializeStudyResults(results);
    assert.equal(text, `${JSON.stringify(results, null, 2)}\n`);
    assert.equal(serializeStudyResults(deriveStudyResults([runInput(new InMemoryEvidence())], LIMITATION_9)), text);
  });
});

describe('deriveExecutionResult', () => {
  it('reads the run: package identity, source, probe, outcome, closure, safety, trials and references', () => {
    const evidence = new InMemoryEvidence();
    const result = deriveExecutionResult(runInput(evidence), LIMITATION_9);
    assert.equal(result.package_directory, RUN_DIRECTORY);
    assert.equal(result.package_index_sha256, evidence.indexDigest(RUN_DIRECTORY));
    assert.equal(result.source_commit, COMMIT);
    assert.deepEqual(result.selected_probe, {
      transport_probe_id: PROBE_ID,
      original_package_index_sha256: PROBE_INDEX,
    });
    assert.deepEqual(result.outcome, {
      run_terminal_reason: 'COMPLETED',
      execution_status: 'completed',
      comparison_eligibility: 'eligible',
    });
    assert.deepEqual(result.closure, {
      cleanup_status: 'succeeded',
      leak_audit_status: 'clean',
      lease_status: 'released',
      safety_status: 'within_limits',
      evidence_integrity_status: 'verified',
    });
    assert.deepEqual(result.safety, {
      safety_status: 'within_limits',
      estimated_cost: { observed_usd: '0.28', declared_limit_usd: '5.00', result: 'within_limits' },
      active_time: { observed_ms: 1131625, declared_limit_ms: 4500000, result: 'within_limits' },
      total_time: { observed_ms: 1512585, declared_limit_ms: 5400000, result: 'within_limits' },
    });
    assert.deepEqual(
      result.trials.map((trial) => [trial.trial_id, trial.preservation_verdict, trial.retry.mechanism]),
      [
        [CONTROL_CONVENTIONAL.id, 'pass', 'none'],
        [TIMEOUT_DURABLE.id, 'fail', 'durable_step_retry'],
      ],
    );
    assert.deepEqual(
      result.evidence_refs.map((ref) => ref.artifact_path),
      [
        'admission/execution-manifest.json',
        'admission/source-provenance.json',
        'summary/run-summary.json',
        'summary/safety-assessment.json',
      ],
    );
  });

  it('cites each verify output by digest with the outcome it states', () => {
    const records = (index: string): readonly LooseFile[] => [
      verificationOf(RUN_ID, {
        record_type: 'package_verification',
        evaluated_at: 't1',
        original_package_index_sha256: index,
        package_eligibility: 'eligible',
      }),
      verificationOf(RUN_ID, {
        record_type: 'study_completion_assessment',
        assessed_at: 't2',
        original_package_index_sha256: index,
        study_completion: 'complete',
        comparison_eligibility: 'eligible',
        package_eligibility: 'eligible',
      }),
    ];
    const input = runInput(new InMemoryEvidence(), records);
    const [package_, completion] = deriveExecutionResult(input, LIMITATION_9).verifications;
    assert.deepEqual(package_, {
      path: input.verifications[0]?.path,
      sha256: digestOf(new TextDecoder().decode(input.verifications[0]?.bytes)),
      record_type: 'package_verification',
      recorded_at: 't1',
      outcome: { package_eligibility: 'eligible' },
    });
    assert.deepEqual(completion?.outcome, {
      study_completion: 'complete',
      comparison_eligibility: 'eligible',
      package_eligibility: 'eligible',
    });
    const validationRecord = { record_type: 'variant_validation_verification', checked_at: 't3' };
    assert.equal(deriveVerification(validationRecord).recorded_at, 't3');
  });

  it('refuses a verify output of an unknown kind or of another package', () => {
    assert.throws(() => deriveVerification({ record_type: 'probe_usability_assessment' }), {
      message: `verifications/${RUN_ID}/2026-10-07T06:00:00.000Z-probe_usability_assessment.json is a probe_usability_assessment; expected one of package_verification, study_completion_assessment, variant_validation_verification`,
    });
    const other = 'f'.repeat(64);
    const evidence = new InMemoryEvidence();
    const input = runInput(evidence, () => [
      verificationOf(RUN_ID, { record_type: 'package_verification', original_package_index_sha256: other }),
    ]);
    assert.throws(() => deriveExecutionResult(input, LIMITATION_9), {
      message: `${input.verifications[0]?.path ?? ''} verifies package ${other}; expected ${RUN_DIRECTORY} at ${evidence.indexDigest(RUN_DIRECTORY)}`,
    });
  });

  it('refuses a summary of another kind or of another execution', () => {
    assert.throws(
      () =>
        deriveExecutionResult(
          editedRun(summaryEdit((summary) => (summary['record_type'] = 'validation_summary'))),
          LIMITATION_9,
        ),
      {
        message: `${RUN_DIRECTORY}/summary/run-summary.json is a validation_summary of ${RUN_ID}; expected the run_summary of ${RUN_ID}`,
      },
    );
    assert.throws(
      () =>
        deriveExecutionResult(editedRun(summaryEdit((summary) => (summary['run_id'] = VALIDATION_ID))), LIMITATION_9),
      {
        message: `${RUN_DIRECTORY}/summary/run-summary.json is a run_summary of ${VALIDATION_ID}; expected the run_summary of ${RUN_ID}`,
      },
    );
  });

  it('refuses a summary whose stated trial verdict differs from the derived one', () => {
    const disagreeing = summaryEdit((summary) => {
      firstOf(summary, 'trial_results')['preservation_verdict'] = 'fail';
    });
    assert.throws(() => deriveExecutionResult(editedRun(disagreeing), LIMITATION_9), {
      message: `${RUN_DIRECTORY} summary trial ${CONTROL_CONVENTIONAL.id} states "CONTROL conventional fail true"; expected the trial's derived "CONTROL conventional pass true"`,
    });
  });

  it('refuses a safety assessment without exactly one check per boundary, or with an unparsable quantity', () => {
    const safety =
      (checks: readonly EditableRecord[]) =>
      (files: FileMap): void => {
        files.set('summary/safety-assessment.json', { safety_status: 'within_limits', checks });
      };
    const cost = {
      boundary: 'ESTIMATED_COST',
      observed: '0.28 USD',
      declared_limit: '5.00 USD',
      result: 'within_limits',
    };
    const time = (boundary: string, observed: string): EditableRecord => ({
      boundary,
      observed,
      declared_limit: '1 ms',
      result: 'within_limits',
    });
    assert.throws(() => deriveExecutionResult(editedRun(safety([cost, cost])), LIMITATION_9), {
      message: `${RUN_DIRECTORY}/summary/safety-assessment.json holds 2 ESTIMATED_COST checks; expected exactly one`,
    });
    assert.throws(() => deriveExecutionResult(editedRun(safety([cost])), LIMITATION_9), {
      message: `${RUN_DIRECTORY}/summary/safety-assessment.json holds 0 ACTIVE_TIME checks; expected exactly one`,
    });
    const badCost = { ...cost, observed: '0.28' };
    assert.throws(() => deriveExecutionResult(editedRun(safety([badCost])), LIMITATION_9), {
      message: `${RUN_DIRECTORY}/summary/safety-assessment.json: observed is "0.28"; expected a quantity matching /^(\\d+\\.\\d{2}) USD$/`,
    });
    const badTime = [cost, time('ACTIVE_TIME', '1.5 ms'), time('TOTAL_TIME', '1 ms')];
    assert.throws(() => deriveExecutionResult(editedRun(safety(badTime)), LIMITATION_9), {
      message: `${RUN_DIRECTORY}/summary/safety-assessment.json: observed is "1.5 ms"; expected a quantity matching /^(\\d+) ms$/`,
    });
  });
});

function deriveVerification(record: EditableRecord): VerificationResult {
  const evidence = new InMemoryEvidence();
  const input = runInput(evidence);
  const index = evidence.indexDigest(RUN_DIRECTORY);
  const file = verificationOf(RUN_ID, {
    ...record,
    original_package_index_sha256: index,
    effective_implementation_validation_status: 'verified',
    validation_validity: 'valid',
    package_eligibility: 'eligible',
  });
  const [result] = deriveExecutionResult({ ...input, verifications: [file] }, LIMITATION_9).verifications;
  assert.ok(result);
  return result;
}

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

  it('reads every flag, repeated validations and --check', () => {
    assert.deepEqual(
      parseDeriveArguments([...base, '--validation', VALIDATION_ID, '--validation', RUN_ID, '--check']),
      {
        evidenceRoot: 'evidence',
        spec: 's.md',
        runs: [RUN_ID],
        validations: [VALIDATION_ID, RUN_ID],
        out: 'r.json',
        check: true,
      },
    );
    assert.deepEqual(parseDeriveArguments(base).validations, []);
    assert.equal(parseDeriveArguments(base).check, false);
  });

  it('refuses an unknown flag, a missing value, a repeated or absent single flag, no run and a malformed id', () => {
    const usage = /^Error: usage: node tools\/derive-study-results\.ts /;
    for (const argv of [
      [...base, '--other', 'x'],
      [...base, '--out'],
      [...base, '--spec', '--check'],
      [...base, '--out', 'again.json'],
      base.slice(2),
      ['--evidence-root', 'evidence', '--spec', 's.md', '--out', 'r.json'],
      [...base, '--validation', '../runs/x'],
      [
        '--evidence-root',
        'evidence',
        '--spec',
        's.md',
        '--run',
        'ABCDEF00-0000-4000-8000-000000000001',
        '--out',
        'r.json',
      ],
    ]) {
      assert.throws(() => parseDeriveArguments(argv), usage, JSON.stringify(argv));
    }
    assert.throws(() => parseDeriveArguments([...base, '--out', 'again.json']), /with 2 --out$/);
  });
});
