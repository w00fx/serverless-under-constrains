// Phases T10 and T11 of one trial (design §10.2, §7, §8.1; BR-RUA-032, BR-RUA-043, BR-RUA-044):
//   T10 write the collected buffer, the queue observations and the settlement samples, journal
//       `settlement_assessed`, then ingest the trial's package files and evaluate the trial into
//       `derived/attempt-projection.json` and `derived/oracle-result.json`
//   T11 build `evidence-index.json` over the trial directory and its execution core files, and
//       journal `trial_evidence_frozen` with the index digest
// A file or evaluation that cannot be written is reported and the freeze goes on: an unsettled or
// partially collected trial still freezes, indeterminate (D-29). Only an index that cannot be
// written fails the freeze, because nothing then freezes the evidence.
//
// The probe freezes through the same steps (`freezeUnitEvidence`): its buffer and samples (it has
// no queue observations), `settlement_assessed`, its own derivation (the transport probe result and
// the coordination prefix checkpoint, probe-workload-executor.ts), then `probe/evidence-index.json`
// and `trial_evidence_frozen` (evidence/CMP-04/decisions.md).
//
// The registry item is not cleared at T11: the store port has no delete (design §5.3 WP-04), and
// the next trial of the variant replaces it with a conditional write (trial-setup.ts), so a late
// redelivery of this trial's message keeps being validated against this trial.

import type { EventBody } from '../event-journal/journal-event.ts';
import { settlementSampleRecord } from '../evidence-collection/settlement-sample.ts';
import type { CaptureScope, TrialCaptureScope } from '../evidence-collection/capture-scope.ts';
import type { TrialCollection } from '../evidence-collection/trial-collection.ts';
import { encodeRecordLines } from '../evidence-collection/collected-records.ts';
import { buildEvidenceIndex, unitOf } from '../evidence-package/evidence-index.ts';
import type { EvidenceIndexTarget } from '../evidence-package/evidence-index.ts';
import { expectedArtifactsFor } from '../evidence-package/expected-artifacts.ts';
import { readPackageSnapshot } from '../evidence-package/package-snapshot.ts';
import { PACKAGE_LAYOUT, UNIT_PATHS } from '../evidence-package/package-layout.ts';
import type { PackageFile } from '../evidence-package/package-file-system.ts';
import { ingestEvidence } from '../evidence-ingestion/ingest-evidence.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type {
  ExecutionIdentity,
  JsonObject,
  Result,
  Sha256Hex,
  StructuredReason,
  WallClock,
} from '../record-contract/primitives.ts';
import type { TrialManifest } from '../record-contract/records/group-a/trial_manifest.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { SettlementAssessment } from '../settlement/settlement-policy.ts';
import { evaluateTrial } from '../trial-oracle/evaluate-trial.ts';
import type { RunnerUnitJournal } from './runner-trial-journal.ts';
import type { SettlementReading } from './settlement-reading.ts';
import type { TrialExecution } from './trial-execution-ports.ts';
import { writeTrialFile, writeUnitFile } from './trial-inputs.ts';
import type { TrialFileTarget } from './trial-inputs.ts';

/** What a unit's freeze writes through, for which unit, and the index that freezes it. */
export interface UnitFreezeContext {
  readonly target: TrialFileTarget;
  readonly journal: RunnerUnitJournal;
  readonly clock: WallClock;
  readonly execution: ExecutionIdentity;
  readonly scope: CaptureScope;
  /** The trial's or the probe's index; it names the same unit as `scope`. */
  readonly index: EvidenceIndexTarget;
}

/** What the freeze writes through and for which trial. */
export interface TrialFreezeContext {
  readonly target: TrialFileTarget;
  readonly journal: RunnerUnitJournal;
  readonly clock: WallClock;
  readonly validator: RecordValidator;
  readonly execution: TrialExecution;
  readonly scope: TrialCaptureScope;
  readonly manifest: TrialManifest;
}

/** The unit's derived files, written after `settlement_assessed`: every problem it tolerated. */
export type UnitDerivation = () => Promise<readonly StructuredReason[]>;

/** What is frozen: the buffer, every settlement round and the settlement judgement. */
export interface TrialFreezeInput {
  readonly collection: TrialCollection;
  readonly rounds: readonly SettlementReading[];
  readonly assessment: SettlementAssessment;
}

/** The written index, and every problem the freeze tolerated. */
export interface FrozenTrialEvidence {
  readonly evidence_index_path: string;
  readonly evidence_index_sha256: Sha256Hex;
  readonly failures: readonly StructuredReason[];
}

/**
 * Writes the trial's evidence, evaluates it and freezes it with its index (T10, T11).
 *
 * @example
 * const frozen = await freezeTrialEvidence(context, { collection, rounds, assessment });
 * if (frozen.ok) frozen.value.evidence_index_path; // 'trials/<trial_id>/evidence-index.json'
 */
export function freezeTrialEvidence(
  context: TrialFreezeContext,
  input: TrialFreezeInput,
): Promise<Result<FrozenTrialEvidence, readonly StructuredReason[]>> {
  const unit: UnitFreezeContext = {
    ...context,
    index: { index_scope: 'TRIAL', execution: context.execution, trial_id: context.manifest.trial_id },
  };
  return freezeUnitEvidence(unit, input, () => writeEvaluation(context));
}

/**
 * Writes a trial's or the probe's buffer and samples, journals `settlement_assessed`, runs the
 * unit's derivation, then freezes the unit with its evidence index and `trial_evidence_frozen`.
 * Only an index that cannot be built or written fails the freeze.
 *
 * @example
 * const frozen = await freezeUnitEvidence(context, { collection, rounds, assessment }, derive);
 * if (frozen.ok) frozen.value.evidence_index_path; // 'probe/evidence-index.json'
 */
export async function freezeUnitEvidence(
  context: UnitFreezeContext,
  input: TrialFreezeInput,
  derive: UnitDerivation,
): Promise<Result<FrozenTrialEvidence, readonly StructuredReason[]>> {
  const failures: StructuredReason[] = [
    ...input.rounds.flatMap((round) => round.failures),
    ...input.collection.failures,
  ];
  await writePrimaryFiles(context, input, failures);
  const assessed = await context.journal.record('settlement_assessed', settlementAssessedBody(input));
  if (!assessed.ok) {
    failures.push(assessed.error);
  }
  failures.push(...(await derive()));
  const index = await writeEvidenceIndex(context);
  if (!index.ok) {
    return err([...failures, ...index.error]);
  }
  const frozen = await context.journal.record('trial_evidence_frozen', {
    evidence_index_path: index.value.path,
    evidence_index_sha256: index.value.sha256,
  });
  if (!frozen.ok) {
    failures.push(frozen.error);
  }
  return ok({ evidence_index_path: index.value.path, evidence_index_sha256: index.value.sha256, failures });
}

/**
 * The `settlement_assessed` body of a judgement over `rounds` samples.
 *
 * @example
 * settlementAssessedBody({ collection, rounds, assessment }).sample_count; // rounds.length
 */
export function settlementAssessedBody(input: TrialFreezeInput): EventBody<'settlement_assessed'> {
  const { assessment } = input;
  const common = { restarts: [...assessment.restarts], sample_count: input.rounds.length };
  if (assessment.status === 'established') {
    return {
      status: 'established',
      window_start: assessment.window_start,
      established_at: assessment.established_at,
      rechecked_at: assessment.rechecked_at,
      reasons: [],
      ...common,
    };
  }
  // The evaluator names at least one reason for every unestablished judgement (DEADLINE when no
  // sample was ever active), which is what the schema's `minItems: 1` asks.
  return {
    status: 'not_established',
    reasons: assessment.reasons as readonly [StructuredReason, ...StructuredReason[]],
    ...common,
  };
}

async function writePrimaryFiles(
  context: UnitFreezeContext,
  input: TrialFreezeInput,
  failures: StructuredReason[],
): Promise<void> {
  const unit = unitOf(context.index);
  for (const file of input.collection.files) {
    if (!Object.hasOwn(UNIT_PATHS, file.key)) {
      failures.push(freezeReason('COLLECTED_FILE_UNPLACED', `collected file ${file.key} has no ${unit.kind} path`));
      continue;
    }
    pushFailure(failures, await writeUnitFile(context.target, unit, file.key as keyof typeof UNIT_PATHS, file.bytes));
  }
  for (const [file, records] of recordLines(context, input.rounds)) {
    const bytes = encodeRecordLines(records, file);
    if (!bytes.ok) {
      failures.push(bytes.error);
      continue;
    }
    pushFailure(failures, await writeUnitFile(context.target, unit, file, bytes.value));
  }
}

// A trial writes its two queue observation files and its samples; the probe, which has no queue
// (design §7), writes its samples only.
function recordLines(
  context: UnitFreezeContext,
  rounds: readonly SettlementReading[],
): readonly (readonly [keyof typeof UNIT_PATHS, readonly JsonObject[]])[] {
  const samples = [
    'settlementSamples',
    rounds.map((round) => settlementSampleRecord(round.sample, context.scope)),
  ] as const;
  if (context.index.index_scope === 'PROBE') {
    return [samples];
  }
  return [
    ['sourceObservations', present(rounds.map((round) => round.source_observation))],
    ['dlqObservations', present(rounds.map((round) => round.dlq_observation))],
    samples,
  ];
}

function present(observations: readonly (JsonObject | undefined)[]): readonly JsonObject[] {
  return observations.filter((observation): observation is JsonObject => observation !== undefined);
}

// Ingestion reads the trial's own files and the execution-level files as artifacts and every
// earlier trial's files as the execution scope (INV-RUA-001), as the golden ingestion input does.
async function writeEvaluation(context: TrialFreezeContext): Promise<readonly StructuredReason[]> {
  const failures: StructuredReason[] = [];
  const snapshot = await readPackageSnapshot(context.target.files, context.execution);
  if (!snapshot.ok) {
    return [freezeReason('PACKAGE_UNREADABLE', `${snapshot.error.code}: ${snapshot.error.detail}`)];
  }
  const subject = `${PACKAGE_LAYOUT.unitDirectory({ kind: 'trial', trial_id: context.manifest.trial_id })}/`;
  const scope = snapshot.value.files.filter(
    (file) => file.path.startsWith('trials/') && !file.path.startsWith(subject),
  );
  const evidence = ingestEvidence(
    {
      artifacts: snapshot.value.files.filter((file) => !scope.includes(file)),
      expected: expectedArtifactsFor(context.manifest),
      execution_scope_artifacts: scope,
    },
    context.validator,
  );
  const evaluation = evaluateTrial({ evidence, checked_at: formatUtcMillis(context.clock.now()) });
  if (!evaluation.ok) {
    return evaluation.error;
  }
  const trialId = context.manifest.trial_id;
  pushFailure(
    failures,
    await writeTrialFile(
      context.target,
      trialId,
      'attemptProjection',
      serializeRecordFile(evaluation.value.projection),
    ),
  );
  pushFailure(
    failures,
    await writeTrialFile(context.target, trialId, 'oracleResult', serializeRecordFile(evaluation.value.result)),
  );
  return failures;
}

async function writeEvidenceIndex(
  context: UnitFreezeContext,
): Promise<Result<{ readonly path: string; readonly sha256: Sha256Hex }, readonly StructuredReason[]>> {
  const snapshot = await readPackageSnapshot(context.target.files, context.execution);
  if (!snapshot.ok) {
    return err([freezeReason('PACKAGE_UNREADABLE', `${snapshot.error.code}: ${snapshot.error.detail}`)]);
  }
  const files: readonly PackageFile[] = snapshot.value.files;
  const index = buildEvidenceIndex({ files, target: context.index, created_at: formatUtcMillis(context.clock.now()) });
  if (!index.ok) {
    return index;
  }
  const unit = unitOf(context.index);
  const bytes = serializeRecordFile(index.value);
  const unwritten = await writeUnitFile(context.target, unit, 'evidenceIndex', bytes);
  if (unwritten !== undefined) {
    return err([unwritten]);
  }
  return ok({ path: PACKAGE_LAYOUT.unitFile(unit, 'evidenceIndex'), sha256: sha256Hex(bytes) });
}

/**
 * The reason a unit freeze step tolerated, in the freeze's own terms (BR-RUA-043).
 *
 * @example
 * freezeReason('PACKAGE_UNREADABLE', 'list failed'); // { code: 'PACKAGE_UNREADABLE', subject: 'BR-RUA-043', ... }
 */
export function freezeReason(code: string, problem: string): StructuredReason {
  return { code, subject: 'BR-RUA-043', detail: `${problem}; expected the unit evidence to be frozen whole` };
}

function pushFailure(failures: StructuredReason[], failure: StructuredReason | undefined): void {
  if (failure !== undefined) {
    failures.push(failure);
  }
}
