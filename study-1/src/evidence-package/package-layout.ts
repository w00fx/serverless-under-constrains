// The evidence package layout on disk (design §7, BR-RUA-035, BR-RUA-043, BR-RUA-044). Every
// path inside a package is a normalized package-relative POSIX path. The constants here are the
// one place the layout is spelled: the artifact classifier, the expected-artifact sets and the
// index builders read them, so a path cannot drift between writer and verifier.
//
// Paths the approved design leaves open are fixed here (evidence/WP-13/decisions.md):
// - `readiness/`: the D-10 canary and the addendum §2 warm-up partitions, as the WP-08 rehearsal
//   export already spells them;
// - `provider/provider-journal.jsonl`: the A-09 execution-level `<execution_id>#provider` partition;
// - amendment payloads are flat files under `payload/`, as the WP-03 catalogue examples spell them,
//   with the authoritative billing export under `payload/billing-export/`.

import type { ExecutionIdentity, ExecutionKind, Uuid4, UtcMillis } from '../record-contract/primitives.ts';

/** Execution-level files of an execution package (design §7). */
export const EXECUTION_PATHS = {
  executionManifest: 'admission/execution-manifest.json',
  environmentInput: 'admission/environment-input.json',
  preflightJournal: 'admission/preflight-journal.jsonl',
  sourceProvenance: 'admission/source-provenance.json',
  oracleRevisionCheck: 'admission/oracle-revision-check.json',
  transportScopeSnapshot: 'admission/transport-scope-snapshot.json',
  deploymentAssemblyInventory: 'admission/deployment-assembly.inventory.json',
  coordinationJournal: 'coordination/coordination-journal.jsonl',
  coordinationPrefixCheckpoint: 'coordination/coordination-prefix-checkpoint.json',
  provisioningJournal: 'provisioning/provisioning-journal.jsonl',
  resourceManifest: 'provisioning/resource-manifest.json',
  runnerJournal: 'runner/runner-journal.jsonl',
  canaryCallerJournal: 'readiness/canary-caller-journal.jsonl',
  canaryControllerJournal: 'readiness/canary-controller-journal.jsonl',
  warmupProviderJournal: 'readiness/warmup-provider-journal.jsonl',
  executionProviderJournal: 'provider/provider-journal.jsonl',
  lateEvidenceStream: 'late-evidence/late-evidence-stream.jsonl',
  lateEvidenceAssessment: 'late-evidence/late-evidence-assessment.json',
  preCleanupSnapshot: 'cleanup/pre-cleanup-snapshot.json',
  cleanupJournal: 'cleanup/cleanup-journal.jsonl',
  cleanupResult: 'cleanup/cleanup-result.json',
  leakAuditResult: 'cleanup/leak-audit-result.json',
  comparisonAssessment: 'summary/comparison-assessment.json',
  safetyAssessment: 'summary/safety-assessment.json',
  runSummary: 'summary/run-summary.json',
  validationSummary: 'summary/validation-summary.json',
  transportProbeSummary: 'summary/transport-probe-summary.json',
  packageIndex: 'package-index.json',
} as const;

/** Directories of the execution package whose every file is one class (design §7). */
export const EXECUTION_DIRECTORIES = {
  /** `schemas/<group>/<record_type>.schema.json` byte copies. */
  schemas: 'admission/schemas/',
  /** The frozen cloud assembly copy; never passed to `cdk --app` (D-25). */
  deploymentAssembly: 'admission/deployment-assembly/',
  /** Excluded from every evidence index (BR-RUA-044). */
  lateEvidence: 'late-evidence/',
} as const;

/** Files of one trial directory (`trials/<trial_id>/`) or of the probe directory (`probe/`). */
export const UNIT_PATHS = {
  trialManifest: 'trial-manifest.json',
  payment: 'inputs/payment.json',
  approvedDecision: 'inputs/approved-decision.json',
  publishedMessage: 'inputs/published-message.json',
  providerTrialConfiguration: 'state/provider-trial-configuration.json',
  treatmentStateSnapshot: 'state/treatment-state-snapshot.json',
  trialRegistration: 'state/trial-registration.json',
  callerJournal: 'journals/caller-journal.jsonl',
  providerJournal: 'journals/provider-journal.jsonl',
  controllerJournal: 'journals/controller-journal.jsonl',
  ledgerSnapshot: 'ledger/ledger-snapshot.json',
  sourceObservations: 'queues/source-observations.jsonl',
  dlqObservations: 'queues/dlq-observations.jsonl',
  dlqSnapshot: 'queues/dlq-snapshot.json',
  settlementSamples: 'settlement/settlement-samples.jsonl',
  durableExecutions: 'execution-metadata/durable-executions.json',
  telemetryAvailability: 'telemetry/telemetry-availability.json',
  attemptProjection: 'derived/attempt-projection.json',
  oracleResult: 'derived/oracle-result.json',
  transportProbeResult: 'derived/transport-probe-result.json',
  evidenceIndex: 'evidence-index.json',
} as const;

/** Files of an amendment package, relative to its directory (design §7, BR-RUA-043). */
export const AMENDMENT_PATHS = {
  amendmentIndex: 'amendment-index.json',
  lateEvidenceStream: 'payload/late-evidence-stream.jsonl',
  lateEvidenceAssessment: 'payload/late-evidence-assessment.json',
  operationalRecoveryRecord: 'payload/operational-recovery-record.json',
  preCleanupSnapshot: 'payload/pre-cleanup-snapshot.json',
  cleanupJournal: 'payload/cleanup-journal.jsonl',
  cleanupResult: 'payload/cleanup-result.json',
  leakAuditResult: 'payload/leak-audit-result.json',
  billingImport: 'payload/billing-import.json',
  /** The authoritative billing export files, kept as exact bytes. */
  billingExportDirectory: 'payload/billing-export/',
} as const;

/** The trial-or-probe directory that owns per-trial evidence. */
export type EvidenceUnit = { readonly kind: 'trial'; readonly trial_id: Uuid4 } | { readonly kind: 'probe' };

/** Package files a verifier writes next to, never inside, a package (design §7 `verifications/`). */
export type VerificationKind =
  | 'package-verification'
  | 'probe-usability-assessment'
  | 'variant-validation-verification'
  | 'study-completion-assessment';

const PACKAGE_ROOTS: Readonly<Record<ExecutionKind, string>> = {
  RUN: 'runs',
  TRANSPORT_PROBE: 'transport-probes',
  VARIANT_VALIDATION: 'variant-validations',
};

const SUMMARY_PATHS: Readonly<Record<ExecutionKind, string>> = {
  RUN: EXECUTION_PATHS.runSummary,
  TRANSPORT_PROBE: EXECUTION_PATHS.transportProbeSummary,
  VARIANT_VALIDATION: EXECUTION_PATHS.validationSummary,
};

/**
 * The single id of an execution identity, whatever its kind.
 *
 * @example
 * executionIdOf({ execution_kind: 'RUN', run_id }); // run_id
 */
export function executionIdOf(identity: ExecutionIdentity): Uuid4 {
  switch (identity.execution_kind) {
    case 'RUN':
      return identity.run_id;
    case 'TRANSPORT_PROBE':
      return identity.transport_probe_id;
    case 'VARIANT_VALIDATION':
      return identity.variant_validation_id;
  }
}

/**
 * Path builders of the evidence root and of one package (design §7).
 *
 * @example
 * PACKAGE_LAYOUT.executionDirectory({ execution_kind: 'RUN', run_id }); // 'runs/<run_id>'
 * PACKAGE_LAYOUT.unitFile({ kind: 'probe' }, 'ledgerSnapshot'); // 'probe/ledger/ledger-snapshot.json'
 */
export const PACKAGE_LAYOUT = {
  /** `runs/<id>`, `transport-probes/<id>` or `variant-validations/<id>`, relative to the evidence root. */
  executionDirectory(identity: ExecutionIdentity): string {
    return `${PACKAGE_ROOTS[identity.execution_kind]}/${executionIdOf(identity)}`;
  },
  /** Every admission attempt keeps its journal here, admitted or not (BR-RUA-039). */
  admissionAttemptDirectory(admissionAttemptId: Uuid4): string {
    return `admission-attempts/${admissionAttemptId}`;
  },
  /** The parent of every amendment of one execution. */
  amendmentsDirectory(identity: ExecutionIdentity): string {
    return `amendments/${executionIdOf(identity)}`;
  },
  /** `amendments/<execution_id>/<seq:4>-<amendment_id>`; the sequence is zero-padded to four digits. */
  amendmentDirectory(identity: ExecutionIdentity, sequence: number, amendmentId: Uuid4): string {
    return `amendments/${executionIdOf(identity)}/${String(sequence).padStart(4, '0')}-${amendmentId}`;
  },
  /** `verifications/<execution_id>/<evaluated_at>-<kind>.json`, outside every package. */
  verificationPath(identity: ExecutionIdentity, evaluatedAt: UtcMillis, kind: VerificationKind): string {
    return `verifications/${executionIdOf(identity)}/${evaluatedAt}-${kind}.json`;
  },
  /** `trials/<trial_id>` or `probe`. */
  unitDirectory(unit: EvidenceUnit): string {
    return unit.kind === 'trial' ? `trials/${unit.trial_id}` : 'probe';
  },
  /** One file of a trial or probe directory. */
  unitFile(unit: EvidenceUnit, file: keyof typeof UNIT_PATHS): string {
    return `${PACKAGE_LAYOUT.unitDirectory(unit)}/${UNIT_PATHS[file]}`;
  },
  /** The lifecycle summary of the package kind. */
  summaryPath(kind: ExecutionKind): string {
    return SUMMARY_PATHS[kind];
  },
} as const;
