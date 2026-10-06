// Reading a canonical run package back for comparison, summary and completion (design §7 layout,
// §8.14). The package is untrusted bytes, so the reader is total (A-05, AC-RUA-046): a file that
// cannot be read, or a record that names another execution or another trial, is reported and then
// treated as absent, and the consumers judge the absence. Only a missing, unreadable or non-RUN
// execution manifest stops the read, because every other file is located and correlated through
// it.

import type { Sha256Hex, StructuredReason, Uuid4 } from '../record-contract/primitives.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result } from '../record-contract/primitives.ts';
import type { ExecutionManifest } from '../record-contract/records/group-a/execution_manifest.ts';
import type { ProviderTrialConfiguration } from '../record-contract/records/group-a/provider_trial_configuration.ts';
import type { ResourceManifest } from '../record-contract/records/group-a/resource_manifest.ts';
import type { SourceProvenance } from '../record-contract/records/group-a/source_provenance.ts';
import type { TrialManifest } from '../record-contract/records/group-a/trial_manifest.ts';
import type { LeaseEventRecorded } from '../record-contract/records/group-b/lease_event_recorded.ts';
import type { CleanupResult } from '../record-contract/records/group-c/cleanup_result.ts';
import type { ComparisonAssessment } from '../record-contract/records/group-c/comparison_assessment.ts';
import type { LateEvidenceAssessment } from '../record-contract/records/group-c/late_evidence_assessment.ts';
import type { LeakAuditResult } from '../record-contract/records/group-c/leak_audit_result.ts';
import type { OracleResult } from '../record-contract/records/group-c/oracle_result.ts';
import type { RunSummary } from '../record-contract/records/group-c/run_summary.ts';
import type { SafetyAssessment } from '../record-contract/records/group-c/safety_assessment.ts';
import type { ArtifactRef } from '../record-contract/records/group-c/shared-shapes.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT, UNIT_PATHS } from '../evidence-package/package-layout.ts';
import { comparisonReason } from './comparison-reasons.ts';
import { bytesRef, readJournalRecords, readRecordFile } from './record-files.ts';
import type {
  FrozenRecord,
  PackageFiles,
  RecordReadingDeps,
  StudyComparisonRecordType,
  StudyComparisonRecords,
} from './record-files.ts';
import type { RunnerEvent } from './run-terminal-reason.ts';
import type { FourDeclaredTrials } from './run-summary.ts';

/** The execution manifest of a canonical run. */
export type RunExecutionManifest = Extract<ExecutionManifest, { readonly execution_kind: 'RUN' }>;

/** The frozen evidence of one declared trial. */
export interface RunTrialRecords {
  readonly trial: FourDeclaredTrials[number];
  readonly trial_manifest: FrozenRecord<TrialManifest> | undefined;
  readonly provider_configuration: FrozenRecord<ProviderTrialConfiguration> | undefined;
  readonly payment: ArtifactRef | undefined;
  readonly approved_decision: ArtifactRef | undefined;
  readonly oracle_result: FrozenRecord<OracleResult> | undefined;
}

/** Everything comparison, summary and completion read from one run package. */
export interface RunPackageRecords {
  readonly run_id: Uuid4;
  readonly execution_manifest: FrozenRecord<RunExecutionManifest>;
  readonly trial_records: readonly [RunTrialRecords, RunTrialRecords, RunTrialRecords, RunTrialRecords];
  readonly resource_manifest: FrozenRecord<ResourceManifest> | undefined;
  readonly source_provenance: FrozenRecord<SourceProvenance> | undefined;
  readonly late_evidence: FrozenRecord<LateEvidenceAssessment> | undefined;
  readonly cleanup: FrozenRecord<CleanupResult> | undefined;
  readonly leak_audit: FrozenRecord<LeakAuditResult> | undefined;
  readonly safety: FrozenRecord<SafetyAssessment> | undefined;
  readonly comparison_assessment: FrozenRecord<ComparisonAssessment> | undefined;
  readonly run_summary: FrozenRecord<RunSummary> | undefined;
  /** Runner-journal phase and interruption events, in file order. */
  readonly runner_events: readonly RunnerEvent[];
  /** Coordination-journal lease events, in file order. */
  readonly lease_events: readonly LeaseEventRecorded[];
  /** Every file or line that could not be read, and every record of another execution or trial. */
  readonly reasons: readonly StructuredReason[];
}

/** The correlation members a record of this execution carries. */
interface Correlated {
  readonly execution_manifest_sha256: Sha256Hex;
  readonly trial_id?: Uuid4;
}

/**
 * Reads a run package; fails only when its execution manifest cannot be read as a RUN manifest.
 *
 * @example
 * const read = readRunPackage(files, { validator, digest: sha256Hex });
 * if (read.ok) read.value.trial_records[3].oracle_result?.record.preservation_verdict;
 */
export function readRunPackage(
  files: PackageFiles,
  deps: RecordReadingDeps,
): Result<RunPackageRecords, readonly StructuredReason[]> {
  const manifest = readRunManifest(files, deps);
  if (!manifest.ok) {
    return manifest;
  }
  const reader = new CorrelatedReader(files, deps, manifest.value.ref.artifact_sha256);
  const [first, second, third, fourth] = manifest.value.record.trials;
  const trialRecords = [
    readTrial(reader, first),
    readTrial(reader, second),
    readTrial(reader, third),
    readTrial(reader, fourth),
  ] as const;
  const runner = readJournalRecords(
    files,
    EXECUTION_PATHS.runnerJournal,
    ['phase_transition_recorded', 'trial_interrupted'],
    deps,
  );
  const lease = readJournalRecords(files, EXECUTION_PATHS.coordinationJournal, ['lease_event_recorded'], deps);
  const records = {
    run_id: manifest.value.record.run_id,
    execution_manifest: manifest.value,
    trial_records: trialRecords,
    resource_manifest: reader.read(EXECUTION_PATHS.resourceManifest, 'resource_manifest'),
    source_provenance: reader.readUncorrelated(EXECUTION_PATHS.sourceProvenance, 'source_provenance'),
    late_evidence: reader.read(EXECUTION_PATHS.lateEvidenceAssessment, 'late_evidence_assessment'),
    cleanup: reader.read(EXECUTION_PATHS.cleanupResult, 'cleanup_result'),
    leak_audit: reader.read(EXECUTION_PATHS.leakAuditResult, 'leak_audit_result'),
    safety: reader.read(EXECUTION_PATHS.safetyAssessment, 'safety_assessment'),
    comparison_assessment: reader.read(EXECUTION_PATHS.comparisonAssessment, 'comparison_assessment'),
    run_summary: reader.read(EXECUTION_PATHS.runSummary, 'run_summary'),
    runner_events: reader.keepCorrelated(EXECUTION_PATHS.runnerJournal, runner.records),
    lease_events: reader.keepCorrelated(EXECUTION_PATHS.coordinationJournal, lease.records),
  };
  return ok({ ...records, reasons: [...reader.reasons, ...runner.reasons, ...lease.reasons] });
}

function readRunManifest(
  files: PackageFiles,
  deps: RecordReadingDeps,
): Result<FrozenRecord<RunExecutionManifest>, readonly StructuredReason[]> {
  const path = EXECUTION_PATHS.executionManifest;
  const read = readRecordFile(files, path, 'execution_manifest', deps);
  if (read.status === 'unreadable') {
    return err([read.reason]);
  }
  if (read.status === 'absent') {
    return err([
      comparisonReason(
        'ARTIFACT_MISSING',
        'execution_manifest',
        `${path} is absent; expected the run's execution manifest`,
        path,
      ),
    ]);
  }
  const { record, ref } = read.frozen;
  if (record.execution_kind !== 'RUN') {
    return err([
      comparisonReason(
        'ARTIFACT_UNREADABLE',
        'execution_manifest',
        `${path} has execution_kind ${record.execution_kind}; expected RUN`,
        path,
      ),
    ]);
  }
  return ok({ record, ref });
}

function readTrial(reader: CorrelatedReader, trial: FourDeclaredTrials[number]): RunTrialRecords {
  const unit = { kind: 'trial', trial_id: trial.trial_id } as const;
  const directory = PACKAGE_LAYOUT.unitDirectory(unit);
  return {
    trial,
    trial_manifest: reader.read(`${directory}/${UNIT_PATHS.trialManifest}`, 'trial_manifest', trial.trial_id),
    provider_configuration: reader.read(
      `${directory}/${UNIT_PATHS.providerTrialConfiguration}`,
      'provider_trial_configuration',
      trial.trial_id,
    ),
    payment: reader.bytes(`${directory}/${UNIT_PATHS.payment}`),
    approved_decision: reader.bytes(`${directory}/${UNIT_PATHS.approvedDecision}`),
    oracle_result: reader.read(`${directory}/${UNIT_PATHS.oracleResult}`, 'oracle_result', trial.trial_id),
  };
}

// Reads records and keeps only those of this execution (and of the expected trial), collecting a
// reason for every file that cannot be used.
class CorrelatedReader {
  readonly reasons: StructuredReason[] = [];
  readonly #files: PackageFiles;
  readonly #deps: RecordReadingDeps;
  readonly #manifestDigest: Sha256Hex;

  constructor(files: PackageFiles, deps: RecordReadingDeps, manifestDigest: Sha256Hex) {
    this.#files = files;
    this.#deps = deps;
    this.#manifestDigest = manifestDigest;
  }

  read<K extends CorrelatedRecordType>(
    path: string,
    recordType: K,
    trialId?: Uuid4,
  ): FrozenRecord<StudyComparisonRecords[K]> | undefined {
    const frozen = this.readUncorrelated(path, recordType);
    if (frozen === undefined) {
      return undefined;
    }
    const problem = this.#correlationProblem(frozen.record, trialId);
    if (problem !== undefined) {
      this.reasons.push(foreign(path, problem));
      return undefined;
    }
    return frozen;
  }

  readUncorrelated<K extends StudyComparisonRecordType>(
    path: string,
    recordType: K,
  ): FrozenRecord<StudyComparisonRecords[K]> | undefined {
    const read = readRecordFile(this.#files, path, recordType, this.#deps);
    if (read.status === 'unreadable') {
      this.reasons.push(read.reason);
    }
    return read.status === 'read' ? read.frozen : undefined;
  }

  bytes(path: string): ArtifactRef | undefined {
    return bytesRef(this.#files, path, this.#deps.digest);
  }

  keepCorrelated<T extends Correlated>(path: string, records: readonly T[]): readonly T[] {
    return records.filter((record) => {
      const problem = this.#correlationProblem(record, undefined);
      if (problem !== undefined) {
        this.reasons.push(foreign(path, problem));
      }
      return problem === undefined;
    });
  }

  #correlationProblem(record: Correlated, trialId: Uuid4 | undefined): string | undefined {
    if (record.execution_manifest_sha256 !== this.#manifestDigest) {
      return `names execution_manifest_sha256 ${record.execution_manifest_sha256}; expected ${this.#manifestDigest}`;
    }
    if (trialId !== undefined && record.trial_id !== trialId) {
      return `names trial ${String(record.trial_id)}; expected ${trialId}`;
    }
    return undefined;
  }
}

/** The record types that carry `execution_manifest_sha256`, so they can be correlated. */
type CorrelatedRecordType = {
  [K in StudyComparisonRecordType]: StudyComparisonRecords[K] extends Correlated ? K : never;
}[StudyComparisonRecordType];

function foreign(path: string, problem: string): StructuredReason {
  return comparisonReason('ARTIFACT_UNREADABLE', 'BR-RUA-033', `${path} ${problem}`, path);
}
