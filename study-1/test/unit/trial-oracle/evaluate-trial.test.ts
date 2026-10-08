// The trial oracle end to end over built evidence (design §8.1, CTR-RUA-001): the result and the
// projection hold their schemas and BR-RUA-035, the identity is the trial's, the instant is the
// injected one, and evidence that names no run or variant-validation trial is refused.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ingestEvidence } from '../../../src/evidence-ingestion/ingest-evidence.ts';
import type { IngestedEvidence } from '../../../src/evidence-ingestion/ingestion-model.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import { evaluateTrial } from '../../../src/trial-oracle/evaluate-trial.ts';
import { builtEvidence, ORACLE_VALIDATOR, trialIngestionInput } from './support/built-trials.ts';
import type { TrialBuild } from './support/built-trials.ts';
import { evaluatedTrial, evaluationContractProblems, UNIT_CHECKED_AT } from './support/evaluated-trials.ts';
import { notDispatched } from './support/trial-edits.ts';
import {
  ACTIVE_CONTROL,
  CONVENTIONAL_CONTROL,
  DLQ_TREATMENT,
  DURABLE_TREATMENT,
  edited,
} from './support/trial-plans.ts';

const PROBE_ID = '6b1d3f5a-7c9e-4a2b-8d4f-0e2c4a6b8d13' as Uuid4;

const BASES = [
  'run-conventional-control',
  'run-durable-control',
  'run-conventional-treatment',
  'run-durable-treatment',
  'validation-conventional-control',
  'validation-conventional-treatment',
  'validation-durable-control',
  'validation-durable-treatment',
] as const;

function contractProblems(build: TrialBuild): readonly string[] {
  return evaluationContractProblems(evaluatedTrial(build));
}

describe('evaluateTrial', () => {
  it('produces a schema-valid result and projection for every base trial', () => {
    for (const base of BASES) {
      assert.deepEqual(contractProblems({ base }), [], base);
    }
  });

  it('holds the contracts on an indeterminate trial and a DLQ-terminated one', () => {
    for (const build of [
      ACTIVE_CONTROL,
      DLQ_TREATMENT,
      edited(CONVENTIONAL_CONTROL, [{ op: 'delete_file', path: '$trial/journals/caller-journal.jsonl' }]),
    ]) {
      assert.deepEqual(contractProblems(build), []);
    }
  });

  // Regressions of the oracle fuzz campaign (FC_SEED 20261006, test/fuzz/trial-oracle): its
  // minimized counterexamples, as builder edits.
  it('keeps the projection valid when an outcome must imply the dispatch or is contradicted by it', () => {
    const withoutDispatchRecord = edited(DURABLE_TREATMENT, [
      {
        op: 'remove_record',
        path: '$trial/journals/caller-journal.jsonl',
        select: { record_type: 'dispatch_started' },
      },
      { op: 'resequence', path: '$trial/journals/caller-journal.jsonl' },
    ]);
    assert.deepEqual(contractProblems(withoutDispatchRecord), []);
    assert.deepEqual(contractProblems(edited(CONVENTIONAL_CONTROL, notDispatched(1))), []);
  });

  it('cites an unreadable ledger when the payment and decision are missing too', () => {
    const build = edited(CONVENTIONAL_CONTROL, [
      { op: 'delete_file', path: '$trial/inputs/payment.json' },
      { op: 'delete_file', path: '$trial/inputs/approved-decision.json' },
      { op: 'truncate', path: '$trial/ledger/ledger-snapshot.json', length: 7 },
    ]);
    assert.deepEqual(contractProblems(build), []);
    const [oneEffect] = evaluatedTrial(build).result.rule_results;
    assert.equal(oneEffect.result, 'indeterminate');
    assert.ok(oneEffect.evidence_refs.some((ref) => ref.artifact_path.endsWith('/ledger/ledger-snapshot.json')));
  });

  it("names the trial's run, trial and manifests, and the injected instant", () => {
    const evidence = builtEvidence(CONVENTIONAL_CONTROL);
    const { result, projection } = evaluatedTrial(CONVENTIONAL_CONTROL);
    const trial = evidence.scope.trial;
    assert.ok(trial !== undefined && evidence.scope.execution?.execution_kind === 'RUN');
    assert.equal('run_id' in result ? result.run_id : undefined, evidence.scope.execution.run_id);
    assert.equal(result.trial_id, trial.trial_id);
    assert.equal(result.trial_manifest_sha256, trial.trial_manifest_sha256);
    assert.equal(result.variant_id, trial.variant_id);
    assert.equal(result.execution_manifest_sha256, evidence.scope.execution_manifest_sha256);
    assert.equal(result.checked_at, UNIT_CHECKED_AT);
    assert.equal(projection.derived_at, UNIT_CHECKED_AT);
    assert.equal(projection.trial_id, trial.trial_id);
  });

  it('names a variant validation by its id', () => {
    const { result } = evaluatedTrial({ base: 'validation-durable-control' });
    assert.ok('variant_validation_id' in result);
    assert.equal('run_id' in result, false);
  });

  it('collects the reasons of every non-verified gate and indeterminate rule', () => {
    const { result } = evaluatedTrial(ACTIVE_CONTROL);
    assert.equal(result.preservation_verdict, 'indeterminate');
    assert.ok(result.indeterminate_reasons.length > 0);
    assert.equal(result.identity_integrity, 'verified');
    assert.equal(result.control_integrity, 'unverified');
  });

  it('is deterministic: the same evidence gives the same evaluation', () => {
    assert.deepEqual(evaluatedTrial(DLQ_TREATMENT), evaluatedTrial(DLQ_TREATMENT));
  });

  it('refuses evidence without an execution manifest', () => {
    const input = trialIngestionInput(CONVENTIONAL_CONTROL);
    const evidence = ingestEvidence(
      {
        ...input,
        artifacts: input.artifacts.filter((artifact) => artifact.path !== 'admission/execution-manifest.json'),
      },
      ORACLE_VALIDATOR,
    );
    const refused = evaluateTrial({ evidence, checked_at: UNIT_CHECKED_AT });
    assert.ok(!refused.ok);
    assert.deepEqual(
      refused.error.map((reason) => [reason.code, reason.subject]),
      [['TRIAL_EXECUTION_UNKNOWN', 'CTR-RUA-001']],
    );
    assert.match(refused.error[0]?.detail ?? '', /execution kind/);
  });

  it('refuses probe evidence, which has no trial', () => {
    const evidence = builtEvidence(CONVENTIONAL_CONTROL);
    const probe: IngestedEvidence = {
      ...evidence,
      scope: { ...evidence.scope, execution: { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: PROBE_ID } },
    };
    const refused = evaluateTrial({ evidence: probe, checked_at: UNIT_CHECKED_AT });
    assert.ok(!refused.ok);
    assert.match(
      refused.error[0]?.detail ?? '',
      /execution kind TRANSPORT_PROBE; expected a RUN or VARIANT_VALIDATION/,
    );
  });

  it('refuses evidence whose execution manifest digest is unknown', () => {
    const evidence = builtEvidence(CONVENTIONAL_CONTROL);
    const { execution_manifest_sha256: _digest, ...scope } = evidence.scope;
    const refused = evaluateTrial({ evidence: { ...evidence, scope }, checked_at: UNIT_CHECKED_AT });
    assert.ok(!refused.ok);
    assert.equal(refused.error[0]?.code, 'TRIAL_EXECUTION_UNKNOWN');
  });

  it('refuses evidence without a usable trial manifest', () => {
    const input = trialIngestionInput(CONVENTIONAL_CONTROL);
    const evidence = ingestEvidence(
      { ...input, artifacts: input.artifacts.filter((artifact) => !artifact.path.endsWith('/trial-manifest.json')) },
      ORACLE_VALIDATOR,
    );
    const refused = evaluateTrial({ evidence, checked_at: UNIT_CHECKED_AT });
    assert.ok(!refused.ok);
    assert.deepEqual(
      refused.error.map((reason) => reason.code),
      ['TRIAL_UNKNOWN'],
    );
  });
});
