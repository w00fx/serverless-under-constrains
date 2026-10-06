// Gate G2 `traceability` (BR-RUA-008; AC-RUA-041; D-28; design §8.3): another execution or trial,
// a manifest reference to another digest, or a mismatch rejection is invalid; missing
// correlation, a correlation rejection, an unresolved predecessor, an unusable manifest or an
// unindexed re-evaluated reference is unverified.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IngestionInput } from '../../../src/evidence-ingestion/ingestion-model.ts';
import { assessTraceability } from '../../../src/evidence-ingestion/traceability-gate.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { GateValue, JsonValue, Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { ScenarioOperation } from '../../support/golden-builder/operation-parsing.ts';
import { appendEvent, rejection } from './support/evidence-edits.ts';
import {
  artifactBytes,
  ingest,
  probeInput,
  subjectOf,
  text,
  trialInput,
  withArtifact,
} from './support/evidence-fixtures.ts';
import { uuid } from './support/indexed-events.ts';

const CALLER = '$trial/journals/caller-journal.jsonl';
const RUNNER = 'runner/runner-journal.jsonl';
const EXECUTION_MANIFEST = 'admission/execution-manifest.json';

function gate(input: IngestionInput): {
  readonly value: GateValue;
  readonly codes: readonly string[];
  readonly result: ReturnType<typeof assessTraceability>;
} {
  const result = assessTraceability(ingest(input));
  return { value: result.value, codes: result.reasons.map((reason) => reason.code), result };
}

function edited(
  operations: readonly ScenarioOperation[],
  base: Parameters<typeof trialInput>[0] = 'run-conventional-control',
): IngestionInput {
  return trialInput(base, operations);
}

function callerPath(input: IngestionInput): string {
  return `${subjectOf(input)}/journals/caller-journal.jsonl`;
}

describe('assessTraceability', () => {
  it('is verified for a clean trial, citing both manifests', () => {
    const input = trialInput();
    const { value, result } = gate(input);
    assert.equal(value, 'verified');
    assert.deepEqual(
      result.evidence_refs.map((ref) => ref.artifact_path),
      [EXECUTION_MANIFEST, `${subjectOf(input)}/trial-manifest.json`],
    );
    assert.equal(gate(probeInput()).value, 'verified');
  });

  it('is invalid when a subject record names another execution', () => {
    const { value, codes, result } = gate(
      edited([{ op: 'set', path: CALLER, select: { line: 3 }, pointer: '/run_id', value: uuid(80) }]),
    );
    assert.equal(value, 'invalid');
    assert.deepEqual(codes, ['EXECUTION_IDENTITY_MISMATCH']);
    assert.equal(result.reasons[0]?.subject, 'BR-RUA-008');
    assert.notEqual(result.reasons[0].event_id, undefined);
    assert.equal(result.evidence_refs.length, 1);
  });

  it('is invalid when a trial-directory document names another trial', () => {
    const { value, codes, result } = gate(
      edited([
        { op: 'set', path: '$trial/state/treatment-state-snapshot.json', pointer: '/trial_id', value: uuid(81) },
      ]),
    );
    assert.equal(value, 'invalid');
    assert.deepEqual(codes, ['TRIAL_IDENTITY_MISMATCH']);
    assert.equal(result.reasons[0]?.event_id, undefined);
    assert.match(
      result.reasons[0]?.detail ?? '',
      /^expected the active trial identity; a record of .* names another$/u,
    );
  });

  it('is invalid when a probe record names any trial', () => {
    const operations: readonly ScenarioOperation[] = [
      {
        op: 'set',
        path: 'probe/journals/caller-journal.jsonl',
        select: { line: 1 },
        pointer: '/trial_id',
        value: uuid(82),
      },
      {
        op: 'set',
        path: 'probe/journals/caller-journal.jsonl',
        select: { line: 1 },
        pointer: '/trial_manifest_sha256',
        value: 'a'.repeat(64),
      },
    ];
    const { value, codes } = gate(probeInput(operations));
    assert.equal(value, 'invalid');
    assert.deepEqual(codes, ['TRIAL_IDENTITY_MISMATCH']);
  });

  it('is invalid when a manifest reference names another digest', () => {
    const { value, codes } = gate(
      edited([{ op: 'set', path: '$trial/trial-manifest.json', pointer: '/payment_sha256', value: 'ab'.repeat(32) }]),
    );
    assert.equal(value, 'invalid');
    assert.deepEqual(codes, ['CORE_FILE_DIGEST_MISMATCH']);
  });

  it('judges the consumer rejections of D-28', () => {
    const input = trialInput();
    const verdicts = [
      'EXECUTION_IDENTITY_MISMATCH',
      'TRIAL_MANIFEST_DIGEST_MISMATCH',
      'CORRELATION_MISSING',
      'NO_ACTIVE_TRIAL',
      'SCHEMA_INVALID',
    ].map((reason) => gate(appendEvent(input, callerPath(input), rejection(reason))));
    assert.deepEqual(
      verdicts.map((verdict) => verdict.value),
      ['invalid', 'invalid', 'unverified', 'verified', 'verified'],
    );
    assert.deepEqual(verdicts[0]?.codes, ['TRIAL_MESSAGE_REJECTED']);
    assert.match(verdicts[2]?.result.reasons[0]?.detail ?? '', /rejected it with CORRELATION_MISSING$/u);
  });

  it('is unverified when a record misses its correlation', () => {
    const { value, codes, result } = gate(
      edited([{ op: 'remove', path: CALLER, select: { line: 3 }, pointer: '/run_id' }]),
    );
    assert.equal(value, 'unverified');
    assert.deepEqual(codes, ['CORRELATION_MISSING']);
    assert.equal(result.evidence_refs.length, 1);
  });

  it('is unverified when a subject event has an absent predecessor, citing the dependent event', () => {
    const { value, codes, result } = gate(
      edited([{ op: 'set', path: CALLER, select: { line: 5 }, pointer: '/causation_event_ids', value: [uuid(83)] }]),
    );
    assert.equal(value, 'unverified');
    assert.deepEqual(codes, ['CAUSAL_PREDECESSOR_MISSING']);
    assert.match(
      result.reasons[0]?.detail ?? '',
      /request_state_recorded to resolve; absent 00000000-0000-4000-8000-000000000053$/u,
    );
    assert.notEqual(result.evidence_refs[0]?.event_id, undefined);
  });

  it('is unverified without a usable manifest: absent ones cite nothing, unusable ones cite the file', () => {
    const input = trialInput();
    const absent = gate(withArtifact(input, EXECUTION_MANIFEST, undefined));
    assert.equal(absent.value, 'unverified');
    assert.deepEqual(
      absent.result.reasons.map((reason) => [reason.code, reason.artifact_path]),
      [['ARTIFACT_MISSING', EXECUTION_MANIFEST]],
    );
    assert.deepEqual(absent.result.evidence_refs, []);
    const manifest = `${subjectOf(input)}/trial-manifest.json`;
    const unusable = gate(withArtifact(input, manifest, text('{}')));
    assert.equal(unusable.value, 'unverified');
    assert.deepEqual(
      unusable.result.reasons.map((reason) => [reason.code, reason.artifact_path]),
      [['MANIFEST_UNUSABLE', manifest]],
    );
    assert.deepEqual(
      unusable.result.evidence_refs.map((ref) => ref.artifact_path),
      [manifest],
    );
  });
});

describe('assessTraceability on re-evaluation', () => {
  const input = trialInput();
  const runnerDigest = sha256Hex(artifactBytes(input, RUNNER));
  const manifestDigest = sha256Hex(artifactBytes(input, EXECUTION_MANIFEST));

  function withSafetyCheck(refs: readonly JsonValue[]): IngestionInput {
    return appendEvent(input, RUNNER, {
      record_type: 'safety_check_recorded',
      boundary: 'ACTIVE_TIME',
      declared_limit: '120 minutes',
      observed: '65 minutes',
      result: 'within_limits',
      evidence_refs: refs,
      checked_at: '2026-10-05T12:00:00.000Z',
    });
  }

  function reevaluated(edited: IngestionInput): IngestionInput {
    const indexed = new Map<string, Sha256Hex>([
      [EXECUTION_MANIFEST, manifestDigest],
      ['runner/runner-journal.jsonl', sha256Hex(artifactBytes(edited, RUNNER))],
    ]);
    return { ...edited, indexed_digests: indexed };
  }

  it('is verified when every in-package reference names indexed bytes, skipping cross-package ones', () => {
    const refs = [
      { artifact_path: EXECUTION_MANIFEST, artifact_sha256: manifestDigest },
      { artifact_path: 'elsewhere/x.json', artifact_sha256: 'a'.repeat(64), package_index_sha256: 'b'.repeat(64) },
    ];
    assert.equal(gate(reevaluated(withSafetyCheck(refs))).value, 'verified');
  });

  it('is unverified for a reference to bytes the index does not hold', () => {
    const { value, codes } = gate(
      reevaluated(withSafetyCheck([{ artifact_path: 'absent/file.json', artifact_sha256: 'a'.repeat(64) }])),
    );
    assert.equal(value, 'unverified');
    assert.deepEqual(codes, ['EVIDENCE_REF_UNRESOLVED']);
  });

  it('is invalid for a reference to other bytes than the indexed ones', () => {
    // Sorted, as BR-RUA-035 requires of every reference list.
    const refs = [
      { artifact_path: 'absent/file.json', artifact_sha256: 'a'.repeat(64) },
      { artifact_path: EXECUTION_MANIFEST, artifact_sha256: runnerDigest },
    ];
    const { value, codes, result } = gate(reevaluated(withSafetyCheck(refs)));
    assert.equal(value, 'invalid');
    assert.deepEqual(codes, ['EVIDENCE_REF_DIGEST_MISMATCH']);
    assert.equal(result.reasons[0]?.artifact_path, RUNNER);
  });

  it('does not check references when the package is not re-evaluated', () => {
    assert.equal(
      gate(withSafetyCheck([{ artifact_path: 'absent/file.json', artifact_sha256: 'a'.repeat(64) }])).value,
      'verified',
    );
  });
});
