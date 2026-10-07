// The late-evidence assessment of a transport probe over a real frozen probe (BR-RUA-043, D-16;
// design §8.13; AC-RUA-030): the golden probe runs end to end offline, and its frozen evidence is
// reassessed with late records copied from its own journals as new events. A late record that
// leaves the probe projection unchanged is `consistent`, one that changes it is `contradictory`
// with every changed field, an incomplete window is `unverified`, and every input the assessment
// cannot judge is refused with the reasons instead of a guessed status.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { frozenProbeEvidence } from '../../../src/execution-lifecycle/frozen-probe-input.ts';
import type { FrozenProbeEvidence } from '../../../src/execution-lifecycle/frozen-probe-input.ts';
import { monitoringOf } from '../../../src/execution-lifecycle/late-evidence-amendment.ts';
import {
  assessProbeLateEvidence,
  probeProjectionChanges,
} from '../../../src/execution-lifecycle/probe-late-evidence.ts';
import type { ProbeLateEvidenceInput } from '../../../src/execution-lifecycle/probe-late-evidence.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import type { JsonObject, Sha256Hex, Uuid4, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { LateEvidenceAssessment } from '../../../src/record-contract/records/group-c/late_evidence_assessment.ts';
import type { TransportProbeResult } from '../../../src/record-contract/records/group-c/transport_probe_result.ts';
import type { LateEvidenceSource } from '../../../src/record-contract/records/group-c/vocabulary.ts';
import { lifecycleValidator } from './support/execution-fixtures.ts';
import { ProbeRunnerWorld } from './support/probe-runner-world.ts';

const PROBE = { kind: 'probe' } as const;
const RESULT_PATH = PACKAGE_LAYOUT.unitFile(PROBE, 'transportProbeResult');
const validator = lifecycleValidator();

const world = await ProbeRunnerWorld.create();
assert.equal((await world.run()).package_finalized, true);
const FILES: readonly PackageFile[] = [...world.cloud.packageFiles()].map(([path, bytes]) => ({ path, bytes }));
const frozen = frozenProbeEvidence(FILES, world.admitted, validator);
assert.ok(frozen.ok && frozen.value !== undefined, 'the probe froze its result');
const FROZEN: FrozenProbeEvidence = frozen.value;
const ORIGINAL = JSON.parse(
  new TextDecoder().decode(world.file(EXECUTION_PATHS.lateEvidenceAssessment)),
) as LateEvidenceAssessment;
const MONITORING = monitoringOf(ORIGINAL);
assert.equal(MONITORING.outcome, 'complete');
const RESULT = JSON.parse(new TextDecoder().decode(FROZEN.result.bytes)) as TransportProbeResult;
const OTHER_MANIFEST = 'f'.repeat(64) as Sha256Hex;
// A schema-valid result the frozen evidence never produced: two invocations make the probe invalid.
const INVALIDATED: TransportProbeResult = {
  ...RESULT,
  probe_validity: 'invalid',
  transport_probe_verdict: 'indeterminate',
  probe_cardinality: { ...RESULT.probe_cardinality, caller_invocations: 2 },
};

function input(overrides: Partial<ProbeLateEvidenceInput> = {}): ProbeLateEvidenceInput {
  return {
    transport_probe_id: world.cloud.identity.transport_probe_id,
    execution_manifest_sha256: world.admitted.manifest_sha256,
    monitoring: MONITORING,
    stream: streamOf([]),
    probe: FROZEN,
    assessed_at: ORIGINAL.assessed_at,
    ...overrides,
  };
}

function streamOf(lines: readonly JsonObject[]): { readonly path: string; readonly bytes: Uint8Array } {
  const text = lines.map((line) => `${canonicalJson(line)}\n`).join('');
  return { path: EXECUTION_PATHS.lateEvidenceStream, bytes: new TextEncoder().encode(text) };
}

function journal(path: string): readonly JsonObject[] {
  return new TextDecoder()
    .decode(world.file(path))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as JsonObject);
}

// A frozen journal record observed again as a new event of its source, after the freeze.
function newEventLike(path: string, recordType: string, eventId: string): JsonObject {
  const records = journal(path);
  const found = records.find((record) => record['record_type'] === recordType);
  assert.ok(found !== undefined, `${path} holds a ${recordType}`);
  const sequence = Math.max(...records.map((record) => Number(record['source_sequence']))) + 1;
  return { ...found, event_id: eventId, source_sequence: sequence };
}

function lateLine(sequence: number, source: LateEvidenceSource, record: JsonObject): JsonObject {
  return {
    schema_version: 1,
    record_type: 'late_evidence_record',
    transport_probe_id: world.cloud.identity.transport_probe_id,
    execution_manifest_sha256: world.admitted.manifest_sha256,
    sequence,
    captured_at: ORIGINAL.assessed_at,
    late_source: source,
    correlated: true,
    late_record_type: typeof record['record_type'] === 'string' ? record['record_type'] : '',
    late_record: record,
  };
}

const LATE_COMMIT = lateLine(
  1,
  'PROVIDER_JOURNAL',
  newEventLike(
    PACKAGE_LAYOUT.unitFile(PROBE, 'providerJournal'),
    'provider_transaction_committed',
    'dddddddd-0000-4000-8000-0000000000f1',
  ),
);
const LATE_CONTROLLER = lateLine(
  1,
  'CONTROLLER_JOURNAL',
  newEventLike(
    PACKAGE_LAYOUT.unitFile(PROBE, 'controllerJournal'),
    'timeout_signal_recorded',
    'dddddddd-0000-4000-8000-0000000000f2',
  ),
);

function assessed(overrides: Partial<ProbeLateEvidenceInput> = {}): LateEvidenceAssessment {
  const assessment = assessProbeLateEvidence(input(overrides), validator);
  assert.ok(assessment.ok, JSON.stringify(assessment));
  return assessment.value;
}

function refusedCodes(overrides: Partial<ProbeLateEvidenceInput>): readonly string[] {
  const assessment = assessProbeLateEvidence(input(overrides), validator);
  assert.ok(!assessment.ok, 'refused');
  return assessment.error.map((reason) => reason.code);
}

describe('AC-RUA-030 assessProbeLateEvidence over a frozen probe', () => {
  it('reproduces the frozen result with no late record as none', () => {
    const assessment = assessed();
    assert.equal(assessment.late_evidence_status, 'none');
    assert.equal(assessment.correlated_record_count, 0);
    assert.deepEqual(assessment.reassessments, [ORIGINAL.reassessments[0]]);
  });

  it('judges a late commit that changes the projection contradictory, naming every changed field', () => {
    const assessment = assessed({ stream: streamOf([LATE_COMMIT]) });
    assert.equal(assessment.late_evidence_status, 'contradictory');
    assert.equal(assessment.correlated_record_count, 1);
    const [reassessment] = assessment.reassessments;
    assert.equal(reassessment?.status, 'contradictory');
    assert.ok(reassessment.changes.length > 0);
    assert.ok(reassessment.changes.every((change) => change.frozen !== change.reassessed));
  });

  it('judges a late record that keeps the projection consistent', () => {
    const assessment = assessed({ stream: streamOf([LATE_CONTROLLER]) });
    assert.equal(assessment.late_evidence_status, 'consistent', JSON.stringify(assessment.reassessments));
    assert.equal(assessment.reassessments[0]?.status, 'consistent');
    assert.deepEqual(assessment.reassessments[0].changes, []);
  });

  it('leaves a shortened window unverified, and a change in it still contradictory', () => {
    const shortened = { ...MONITORING, outcome: 'shortened' as const };
    const quiet = assessed({ monitoring: shortened });
    assert.equal(quiet.monitoring, 'shortened');
    assert.equal(quiet.late_evidence_status, 'unverified');
    assert.equal(quiet.reassessments[0]?.status, 'unverified');
    const changed = assessed({ monitoring: shortened, stream: streamOf([LATE_COMMIT]) });
    assert.equal(changed.late_evidence_status, 'unverified');
    assert.equal(changed.reassessments[0]?.status, 'contradictory');
  });

  it('counts a window whose stream is absent as unverified, and a skipped one as skipped', () => {
    const { stream: _stream, ...withoutStream } = input();
    const missing = assessProbeLateEvidence(withoutStream, validator);
    assert.ok(missing.ok);
    assert.equal(missing.value.late_evidence_status, 'unverified');
    assert.deepEqual(missing.value.evidence_refs, []);
    assert.ok(
      missing.value.reasons.some((reason) => reason.detail.includes('is absent; expected the stream')),
      JSON.stringify(missing.value.reasons),
    );
    const skipped = assessProbeLateEvidence({ ...withoutStream, monitoring: { outcome: 'skipped' } }, validator);
    assert.ok(skipped.ok);
    assert.equal(skipped.value.monitoring, 'skipped');
    assert.equal(skipped.value.monitoring_started_at, undefined);
    assert.ok(skipped.value.reasons.every((reason) => !reason.detail.includes('is absent; expected the stream')));
  });

  it('names late evidence of a probe that froze no result, counting the others', () => {
    const second = { ...LATE_CONTROLLER, sequence: 2 };
    const { probe: _probe, ...withoutProbe } = input();
    const one = assessProbeLateEvidence({ ...withoutProbe, stream: streamOf([LATE_CONTROLLER]) }, validator);
    const two = assessProbeLateEvidence({ ...withoutProbe, stream: streamOf([LATE_CONTROLLER, second]) }, validator);
    assert.ok(one.ok && two.ok);
    assert.equal(one.value.late_evidence_status, 'consistent');
    assert.deepEqual(one.value.reassessments, []);
    const [reason] = one.value.reasons;
    assert.equal(reason?.code, 'LATE_RECORD_WITHOUT_FROZEN_RESULT');
    assert.match(
      reason.detail,
      /line 1 correlates with the probe, which froze no transport probe result; expected a frozen result to reassess$/,
    );
    assert.match(two.value.reasons[0]?.detail ?? '', /to reassess \(and 1 more\)$/);
  });
});

describe('assessProbeLateEvidence refuses what it cannot judge', () => {
  it('refuses a misplaced stream together with an unreadable window', () => {
    const codes = refusedCodes({
      // An end without a start is not a window.
      monitoring: { outcome: 'failed', ended_at: ORIGINAL.assessed_at },
      stream: { path: 'late-evidence/elsewhere.jsonl', bytes: new Uint8Array() },
    });
    assert.equal(codes.at(-1), 'LATE_STREAM_MISPLACED');
    assert.equal(codes.length, 2);
  });

  it('refuses a frozen result of another manifest or probe', () => {
    assert.deepEqual(refusedCodes({ execution_manifest_sha256: OTHER_MANIFEST }), ['FROZEN_RESULT_FOREIGN']);
    assert.deepEqual(refusedCodes({ transport_probe_id: '0f0f0f0f-0000-4000-8000-000000000009' as Uuid4 }), [
      'FROZEN_RESULT_FOREIGN',
    ]);
  });

  it('refuses a frozen result that is not a valid transport probe result', () => {
    const invalid = new TextEncoder().encode(`${JSON.stringify({ ...RESULT, transport_probe_verdict: 'maybe' })}\n`);
    const codes = refusedCodes({ probe: { ...FROZEN, result: { path: RESULT_PATH, bytes: invalid } } });
    assert.deepEqual(codes, ['FROZEN_RESULT_UNREADABLE']);
  });

  it('refuses a frozen result its frozen evidence no longer reproduces', () => {
    const altered = new TextEncoder().encode(`${JSON.stringify(INVALIDATED)}\n`);
    const assessment = assessProbeLateEvidence(
      input({
        probe: { ...FROZEN, result: { path: RESULT_PATH, bytes: altered } },
        stream: streamOf([LATE_CONTROLLER]),
      }),
      validator,
    );
    assert.ok(!assessment.ok);
    assert.deepEqual(
      assessment.error.map((reason) => reason.code),
      ['FROZEN_RESULT_NOT_REPRODUCED'],
    );
    assert.match(
      assessment.error[0]?.detail ?? '',
      /^the frozen evidence alone re-derives \/transport_probe_verdict "pass" where the frozen result holds "indeterminate" \(3 field\(s\) differ\); expected it to reproduce/,
    );
  });

  it('refuses a re-derivation the frozen evidence cannot make', () => {
    const artifacts = FROZEN.frozen.artifacts.filter((artifact) => artifact.path !== EXECUTION_PATHS.executionManifest);
    const codes = refusedCodes({
      probe: { ...FROZEN, frozen: { ...FROZEN.frozen, artifacts } },
      stream: streamOf([LATE_CONTROLLER]),
    });
    assert.ok(codes.length > 0 && codes.every((code) => code === 'REEVALUATION_REFUSED'), codes.join());
  });

  it('refuses an assessment its own schema cannot represent', () => {
    const { probe: _probe, ...withoutProbe } = input();
    const assessment = assessProbeLateEvidence(
      { ...withoutProbe, assessed_at: 'not an instant' as UtcMillis },
      validator,
    );
    assert.ok(!assessment.ok);
    assert.deepEqual(
      assessment.error.map((reason) => reason.code),
      ['ASSESSMENT_SCHEMA_INVALID'],
    );
    assert.match(assessment.error[0]?.detail ?? '', /; expected a valid late_evidence_assessment$/);
  });
});

describe('probeProjectionChanges', () => {
  it('names nothing for the same result', () => {
    assert.deepEqual(probeProjectionChanges(RESULT, RESULT), []);
  });

  it('names a condition one side lacks as null on that side', () => {
    // Deliberately not six conditions: the projection must still name what one side lacks.
    const fewer = {
      ...RESULT,
      condition_results: RESULT.condition_results.slice(1),
    } as unknown as TransportProbeResult;
    const last = RESULT.condition_results.length - 1;
    const changes = probeProjectionChanges(RESULT, fewer);
    assert.ok(
      changes.some(
        (change) => change.field === `/condition_results/${String(last)}/condition_id` && change.reassessed === null,
      ),
    );
    assert.ok(probeProjectionChanges(fewer, RESULT).some((change) => change.frozen === null));
  });

  it('names a changed verdict, validity and cardinality by their pointers', () => {
    assert.deepEqual(probeProjectionChanges(RESULT, INVALIDATED), [
      { field: '/transport_probe_verdict', frozen: 'pass', reassessed: 'indeterminate' },
      { field: '/probe_validity', frozen: 'valid', reassessed: 'invalid' },
      { field: '/probe_cardinality/caller_invocations', frozen: 1, reassessed: 2 },
    ]);
  });
});

describe('frozenProbeEvidence', () => {
  function withFile(path: string, bytes: Uint8Array | undefined): readonly PackageFile[] {
    const others = FILES.filter((file) => file.path !== path);
    return bytes === undefined ? others : [...others, { path, bytes }];
  }

  function frozenRunnerJournal(files: readonly PackageFile[]): Uint8Array | undefined {
    const read = frozenProbeEvidence(files, world.admitted, validator);
    assert.ok(read.ok && read.value !== undefined);
    return read.value.frozen.artifacts.find((artifact) => artifact.path === EXECUTION_PATHS.runnerJournal)?.bytes;
  }

  it('is nothing when no probe result was frozen', () => {
    assert.deepEqual(frozenProbeEvidence(withFile(RESULT_PATH, undefined), world.admitted, validator), {
      ok: true,
      value: undefined,
    });
  });

  it('leaves out what P5 and T11 wrote, and cuts the journals that kept growing', () => {
    const paths = FROZEN.frozen.artifacts.map((artifact) => artifact.path);
    assert.ok(!paths.includes(RESULT_PATH));
    assert.ok(!paths.includes(PACKAGE_LAYOUT.unitFile(PROBE, 'evidenceIndex')));
    assert.ok(!paths.includes(EXECUTION_PATHS.coordinationPrefixCheckpoint));
    assert.ok(!paths.includes(EXECUTION_PATHS.packageIndex));
    const checkpoint = JSON.parse(
      new TextDecoder().decode(world.file(EXECUTION_PATHS.coordinationPrefixCheckpoint)),
    ) as {
      prefix_byte_count: number;
    };
    const coordination = FROZEN.frozen.artifacts.find(
      (artifact) => artifact.path === EXECUTION_PATHS.coordinationJournal,
    );
    assert.equal(coordination?.bytes.length, checkpoint.prefix_byte_count);
    const runner = new TextDecoder().decode(frozenRunnerJournal(FILES));
    assert.ok(!runner.includes('"PROBE_FREEZE"') && !runner.includes('trial_evidence_frozen'));
    assert.ok(runner.length > 0 && runner.endsWith('\n'));
  });

  it('keeps a runner journal without a freeze event whole, terminated or not', () => {
    const lines = new TextDecoder().decode(world.file(EXECUTION_PATHS.runnerJournal)).split('\n');
    const freeze = lines.findIndex((line) => line.includes('"PROBE_FREEZE"'));
    const before = `${lines.slice(0, freeze).join('\n')}\n`;
    const whole = new TextEncoder().encode(before);
    assert.deepEqual(frozenRunnerJournal(withFile(EXECUTION_PATHS.runnerJournal, whole)), whole);
    const unterminated = new TextEncoder().encode(before.slice(0, -1));
    assert.deepEqual(frozenRunnerJournal(withFile(EXECUTION_PATHS.runnerJournal, unterminated)), unterminated);
  });

  for (const [name, bytes] of [
    ['is absent', undefined],
    ['is not JSON', new TextEncoder().encode('{"prefix_byte_count":')],
    ['holds a negative count', new TextEncoder().encode('{"prefix_byte_count":-1}\n')],
    ['holds a fractional count', new TextEncoder().encode('{"prefix_byte_count":1.5}\n')],
    ['holds no count', new TextEncoder().encode('[1]\n')],
  ] as const) {
    it(`refuses a coordination prefix checkpoint that ${name}`, () => {
      const read = frozenProbeEvidence(
        withFile(EXECUTION_PATHS.coordinationPrefixCheckpoint, bytes),
        world.admitted,
        validator,
      );
      assert.ok(!read.ok);
      assert.equal(read.error.code, 'FROZEN_PROBE_INPUT_UNREADABLE');
      assert.match(read.error.detail, /coordination-prefix-checkpoint\.json has no readable prefix_byte_count/);
    });
  }
});
