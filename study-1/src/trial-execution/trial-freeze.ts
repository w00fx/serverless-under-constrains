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
// The registry item is not cleared at T11: the store port has no delete (design §5.3 WP-04), and
// the next trial of the variant replaces it with a conditional write (trial-setup.ts), so a late
// redelivery of this trial's message keeps being validated against this trial.

import type { EventBody } from '../event-journal/journal-event.ts';
import { settlementSampleRecord } from '../evidence-collection/settlement-sample.ts';
import type { TrialCaptureScope } from '../evidence-collection/capture-scope.ts';
import type { TrialCollection } from '../evidence-collection/trial-collection.ts';
import { encodeRecordLines } from '../evidence-collection/collected-records.ts';
import { buildEvidenceIndex } from '../evidence-package/evidence-index.ts';
import { expectedArtifactsFor } from '../evidence-package/expected-artifacts.ts';
import { readPackageSnapshot } from '../evidence-package/package-snapshot.ts';
import { PACKAGE_LAYOUT, UNIT_PATHS } from '../evidence-package/package-layout.ts';
import type { PackageFile } from '../evidence-package/package-file-system.ts';
import { ingestEvidence } from '../evidence-ingestion/ingest-evidence.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonObject, Result, Sha256Hex, StructuredReason, WallClock } from '../record-contract/primitives.ts';
import type { TrialManifest } from '../record-contract/records/group-a/trial_manifest.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { SettlementAssessment } from '../settlement/settlement-policy.ts';
import { evaluateTrial } from '../trial-oracle/evaluate-trial.ts';
import type { RunnerTrialJournal } from './runner-trial-journal.ts';
import type { SettlementReading } from './settlement-reading.ts';
import type { TrialExecution } from './trial-execution-ports.ts';
import { writeTrialFile } from './trial-inputs.ts';
import type { TrialFileTarget } from './trial-inputs.ts';

/** What the freeze writes through and for which trial. */
export interface TrialFreezeContext {
  readonly target: TrialFileTarget;
  readonly journal: RunnerTrialJournal;
  readonly clock: WallClock;
  readonly validator: RecordValidator;
  readonly execution: TrialExecution;
  readonly scope: TrialCaptureScope;
  readonly manifest: TrialManifest;
}

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
export async function freezeTrialEvidence(
  context: TrialFreezeContext,
  input: TrialFreezeInput,
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
  await writeEvaluation(context, failures);
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
  context: TrialFreezeContext,
  input: TrialFreezeInput,
  failures: StructuredReason[],
): Promise<void> {
  const trialId = context.manifest.trial_id;
  for (const file of input.collection.files) {
    if (!Object.hasOwn(UNIT_PATHS, file.key)) {
      failures.push(freezeReason('COLLECTED_FILE_UNPLACED', `collected file ${file.key} has no trial path`));
      continue;
    }
    pushFailure(
      failures,
      await writeTrialFile(context.target, trialId, file.key as keyof typeof UNIT_PATHS, file.bytes),
    );
  }
  const lines: readonly (readonly [keyof typeof UNIT_PATHS, readonly JsonObject[]])[] = [
    ['sourceObservations', input.rounds.map((round) => round.source_observation)],
    ['dlqObservations', input.rounds.map((round) => round.dlq_observation)],
    ['settlementSamples', input.rounds.map((round) => settlementSampleRecord(round.sample, context.scope))],
  ];
  for (const [file, records] of lines) {
    const bytes = encodeRecordLines(records, file);
    if (!bytes.ok) {
      failures.push(bytes.error);
      continue;
    }
    pushFailure(failures, await writeTrialFile(context.target, trialId, file, bytes.value));
  }
}

// Ingestion reads the trial's own files and the execution-level files as artifacts and every
// earlier trial's files as the execution scope (INV-RUA-001), as the golden ingestion input does.
async function writeEvaluation(context: TrialFreezeContext, failures: StructuredReason[]): Promise<void> {
  const snapshot = await readPackageSnapshot(context.target.files, context.execution);
  if (!snapshot.ok) {
    failures.push(freezeReason('PACKAGE_UNREADABLE', `${snapshot.error.code}: ${snapshot.error.detail}`));
    return;
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
    failures.push(...evaluation.error);
    return;
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
}

async function writeEvidenceIndex(
  context: TrialFreezeContext,
): Promise<Result<{ readonly path: string; readonly sha256: Sha256Hex }, readonly StructuredReason[]>> {
  const snapshot = await readPackageSnapshot(context.target.files, context.execution);
  if (!snapshot.ok) {
    return err([freezeReason('PACKAGE_UNREADABLE', `${snapshot.error.code}: ${snapshot.error.detail}`)]);
  }
  const files: readonly PackageFile[] = snapshot.value.files;
  const index = buildEvidenceIndex({
    files,
    target: { index_scope: 'TRIAL', execution: context.execution, trial_id: context.manifest.trial_id },
    created_at: formatUtcMillis(context.clock.now()),
  });
  if (!index.ok) {
    return index;
  }
  const bytes = serializeRecordFile(index.value);
  const unwritten = await writeTrialFile(context.target, context.manifest.trial_id, 'evidenceIndex', bytes);
  if (unwritten !== undefined) {
    return err([unwritten]);
  }
  const path = PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: context.manifest.trial_id }, 'evidenceIndex');
  return ok({ path, sha256: sha256Hex(bytes) });
}

function pushFailure(failures: StructuredReason[], failure: StructuredReason | undefined): void {
  if (failure !== undefined) {
    failures.push(failure);
  }
}

function freezeReason(code: string, problem: string): StructuredReason {
  return { code, subject: 'BR-RUA-043', detail: `${problem}; expected the trial evidence to be frozen whole` };
}
