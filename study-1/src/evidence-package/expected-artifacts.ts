// The artifacts the oracle expects for one trial or for the probe (design §8.1 "Expected artifact
// set"; BR-RUA-037). Ingestion reports an expected artifact that is absent as ARTIFACT_MISSING, so
// this set decides which evidence a verdict needs:
// - required: execution, trial and resource manifests, payment, approved decision, published
//   message, provider trial configuration, treatment-state snapshot, the caller, provider and
//   controller journals (an empty file is valid), the runner journal, the ledger snapshot, the
//   settlement samples and the source and DLQ observations; the Durable execution metadata too
//   when the variant is Durable;
// - conditional: the DLQ snapshot, required when an observation or sample shows a correlated DLQ
//   message (ingestion decides that condition);
// - optional and diagnostic: telemetry availability (BR-RUA-037: its absence never blocks).
// The probe has no trial manifest, published message, queues or Durable metadata (design §7).

import type { ProbeWorkloadRequest } from '../record-contract/records/group-a/probe_workload_request.ts';
import type { TrialManifest } from '../record-contract/records/group-a/trial_manifest.ts';
import type { ArtifactClass } from '../record-contract/records/group-c/vocabulary.ts';
import { EXECUTION_FILE_CLASSES, UNIT_FILE_CLASSES } from './artifact-classification.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from './package-layout.ts';
import type { EvidenceUnit } from './package-layout.ts';

export type ArtifactRequirement = 'required' | 'conditional' | 'optional';

/** One artifact a trial or probe evaluation expects, at its package-relative path. */
export interface ExpectedPackageArtifact {
  readonly path: string;
  readonly artifact_class: ArtifactClass;
  readonly requirement: ArtifactRequirement;
}

type UnitFileKey = keyof typeof UNIT_FILE_CLASSES;
type ExecutionFileKey = keyof typeof EXECUTION_FILE_CLASSES;

const EXECUTION_REQUIRED: readonly ExecutionFileKey[] = ['executionManifest', 'resourceManifest', 'runnerJournal'];

const UNIT_REQUIRED_BOTH: readonly UnitFileKey[] = [
  'payment',
  'approvedDecision',
  'providerTrialConfiguration',
  'treatmentStateSnapshot',
  'callerJournal',
  'providerJournal',
  'controllerJournal',
  'ledgerSnapshot',
  'settlementSamples',
];

const TRIAL_ONLY_REQUIRED: readonly UnitFileKey[] = [
  'trialManifest',
  'publishedMessage',
  'sourceObservations',
  'dlqObservations',
];

/**
 * The expected artifacts of a trial (from its frozen manifest) or of the probe (from its workload
 * request), sorted by path.
 *
 * @example
 * expectedArtifactsFor(trialManifest).find((a) => a.artifact_class === 'dlq_snapshot')?.requirement; // 'conditional'
 */
export function expectedArtifactsFor(plan: TrialManifest | ProbeWorkloadRequest): readonly ExpectedPackageArtifact[] {
  const unit: EvidenceUnit =
    plan.record_type === 'trial_manifest' ? { kind: 'trial', trial_id: plan.trial_id } : { kind: 'probe' };
  const required: readonly UnitFileKey[] =
    plan.record_type === 'trial_manifest'
      ? [
          ...UNIT_REQUIRED_BOTH,
          ...TRIAL_ONLY_REQUIRED,
          ...(plan.variant_id === 'durable' ? ['durableExecutions' as const] : []),
        ]
      : UNIT_REQUIRED_BOTH;
  const conditional: readonly UnitFileKey[] = unit.kind === 'trial' ? ['dlqSnapshot'] : [];
  const artifacts = [
    ...EXECUTION_REQUIRED.map((key) => executionArtifact(key)),
    ...required.map((key) => unitArtifact(unit, key, 'required')),
    ...conditional.map((key) => unitArtifact(unit, key, 'conditional')),
    unitArtifact(unit, 'telemetryAvailability', 'optional'),
  ];
  return artifacts.toSorted((a, b) => (a.path < b.path ? -1 : 1));
}

function executionArtifact(key: ExecutionFileKey): ExpectedPackageArtifact {
  return {
    path: EXECUTION_PATHS[key],
    artifact_class: EXECUTION_FILE_CLASSES[key].artifact_class,
    requirement: 'required',
  };
}

function unitArtifact(unit: EvidenceUnit, key: UnitFileKey, requirement: ArtifactRequirement): ExpectedPackageArtifact {
  return {
    path: PACKAGE_LAYOUT.unitFile(unit, key),
    artifact_class: UNIT_FILE_CLASSES[key].artifact_class,
    requirement,
  };
}
