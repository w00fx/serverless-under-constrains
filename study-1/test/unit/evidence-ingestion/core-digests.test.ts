// Design §8.2 step I3 (BR-RUA-034, BR-RUA-040): the trial manifest pins the resource manifest,
// payment and approved decision by digest; every record of the active execution names the
// execution manifest's digest; every record of the subject trial names the trial manifest's; a
// re-evaluated package's bytes match its evidence index. A difference is CORE_FILE_DIGEST_MISMATCH.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readArtifacts } from '../../../src/evidence-ingestion/artifact-reading.ts';
import { checkCoreDigests } from '../../../src/evidence-ingestion/core-digests.ts';
import type { IngestionFinding, IngestionInput } from '../../../src/evidence-ingestion/ingestion-model.ts';
import { classifyRecords } from '../../../src/evidence-ingestion/record-classification.ts';
import { resolveScope } from '../../../src/evidence-ingestion/scope-resolution.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { ScenarioOperation } from '../../support/golden-builder/operation-parsing.ts';
import { VALIDATOR, artifactBytes, subjectOf, text, trialInput, withArtifact } from './support/evidence-fixtures.ts';
import { uuid } from './support/indexed-events.ts';

const WRONG = 'ab'.repeat(32);
const CALLER = '$trial/journals/caller-journal.jsonl';

function digestFindings(input: IngestionInput, indexed?: ReadonlyMap<string, Sha256Hex>): readonly IngestionFinding[] {
  const reading = readArtifacts(input);
  const scope = resolveScope(reading.artifacts, input.expected, indexed !== undefined, VALIDATOR);
  return checkCoreDigests(classifyRecords(reading.artifacts, scope, VALIDATOR).artifacts, scope, indexed);
}

function setOn(path: string, pointer: string, value: string, line?: number): ScenarioOperation {
  return line === undefined
    ? { op: 'set', path, pointer, value }
    : { op: 'set', path, select: { line }, pointer, value };
}

describe('checkCoreDigests', () => {
  it('finds nothing when every core digest agrees', () => {
    assert.deepEqual(digestFindings(trialInput('run-durable-treatment')), []);
  });

  it('reports each trial manifest pin that is not the pinned file digest', () => {
    for (const [member, file] of [
      ['payment_sha256', 'inputs/payment.json'],
      ['approved_decision_sha256', 'inputs/approved-decision.json'],
      ['resource_manifest_sha256', '../../provisioning/resource-manifest.json'],
    ] as const) {
      const input = trialInput('run-conventional-control', [setOn('$trial/trial-manifest.json', `/${member}`, WRONG)]);
      const pinned = file.startsWith('../') ? 'provisioning/resource-manifest.json' : `${subjectOf(input)}/${file}`;
      const findings = digestFindings(input);
      assert.equal(findings.length, 1, member);
      assert.deepEqual(findings[0], {
        code: 'CORE_FILE_DIGEST_MISMATCH',
        subject: 'BR-RUA-034',
        artifact_path: `${subjectOf(input)}/trial-manifest.json`,
        detail: `${member} names ${WRONG}; expected the digest of ${pinned}`,
        occurrences: 1,
      });
    }
  });

  it('leaves an absent pinned file to I1 and skips the pins of an unusable or absent manifest', () => {
    const input = trialInput();
    const subject = subjectOf(input);
    assert.deepEqual(digestFindings(withArtifact(input, `${subject}/inputs/payment.json`, undefined)), []);
    const unusable = trialInput('run-conventional-control', [
      { op: 'set', path: '$trial/trial-manifest.json', pointer: '/sequence', value: 0 },
      setOn('$trial/trial-manifest.json', '/payment_sha256', WRONG),
    ]);
    assert.deepEqual(digestFindings(unusable), []);
    assert.deepEqual(digestFindings(withArtifact(input, `${subject}/trial-manifest.json`, undefined)), []);
  });

  it('aggregates records that name another execution manifest digest, per artifact', () => {
    const input = trialInput('run-conventional-control', [
      setOn(CALLER, '/execution_manifest_sha256', WRONG, 2),
      setOn(CALLER, '/execution_manifest_sha256', WRONG, 4),
    ]);
    const caller = `${subjectOf(input)}/journals/caller-journal.jsonl`;
    const findings = digestFindings(input);
    assert.equal(findings.length, 1);
    const [finding] = findings;
    assert.equal(finding?.artifact_path, caller);
    assert.equal(finding.occurrences, 2);
    assert.match(finding.event_id ?? '', /^[0-9a-f-]{36}$/u);
    assert.equal(
      finding.detail,
      `line 2: execution_manifest_sha256 names "${WRONG}"; expected the execution manifest digest (and 1 more)`,
    );
  });

  it('reports a subject trial record that names another trial manifest digest', () => {
    const input = trialInput('run-conventional-control', [
      setOn('$trial/state/treatment-state-snapshot.json', '/trial_manifest_sha256', WRONG),
    ]);
    const findings = digestFindings(input);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.artifact_path, `${subjectOf(input)}/state/treatment-state-snapshot.json`);
    assert.equal(findings[0].event_id, undefined);
    assert.equal(
      findings[0].detail,
      `document: trial_manifest_sha256 names "${WRONG}"; expected the trial manifest digest`,
    );
  });

  it('does not bind records of another trial or execution, nor schema-invalid records', () => {
    const input = trialInput('run-conventional-control', [
      setOn(CALLER, '/trial_id', uuid(77), 2),
      setOn(CALLER, '/trial_manifest_sha256', WRONG, 2),
      setOn(CALLER, '/run_id', uuid(78), 3),
      setOn(CALLER, '/execution_manifest_sha256', WRONG, 3),
      setOn(CALLER, '/execution_manifest_sha256', 'not-a-digest', 4),
    ]);
    assert.deepEqual(digestFindings(input), []);
  });

  it('checks only the trial digest when the execution manifest is unusable', () => {
    const input = withArtifact(
      trialInput('run-conventional-control', [
        setOn(CALLER, '/execution_manifest_sha256', WRONG, 2),
        setOn(CALLER, '/trial_manifest_sha256', WRONG, 3),
      ]),
      'admission/execution-manifest.json',
      text('{'),
    );
    const findings = digestFindings(input);
    assert.deepEqual(
      findings.map((finding) => finding.detail.split(' ')[2]),
      ['trial_manifest_sha256'],
    );
  });

  it('compares re-evaluated bytes with the evidence index, ignoring unindexed and earlier-trial files', () => {
    const input = trialInput();
    const caller = `${subjectOf(input)}/journals/caller-journal.jsonl`;
    const [scopePath] = input.execution_scope_artifacts.map((artifact) => artifact.path);
    const indexed = new Map<string, Sha256Hex>([
      [caller, WRONG as Sha256Hex],
      ['runner/runner-journal.jsonl', sha256Hex(artifactBytes(input, 'runner/runner-journal.jsonl'))],
      [scopePath ?? '', WRONG as Sha256Hex],
    ]);
    const findings = digestFindings(input, indexed);
    assert.deepEqual(findings, [
      {
        code: 'CORE_FILE_DIGEST_MISMATCH',
        subject: 'BR-RUA-034',
        artifact_path: caller,
        detail: `bytes digest to ${sha256Hex(artifactBytes(input, caller))}; expected the evidence index digest ${WRONG}`,
        occurrences: 1,
      },
    ]);
  });
});
