// Artifact classification (BR-RUA-037, AC-RUA-010): every package file has exactly one artifact
// class and is either primary evidence or derived from it. Classification is by path alone, over
// the design §7 layout; a path the layout does not name is unclassifiable, so an index build fails
// instead of dropping a file silently.
//
// Derivation follows the catalogue kinds (design §6.2): inputs, manifests, journal events and
// observations (I, M, E, O) are primary; derived results and operational results (D, P) are
// derived, which covers every artifact BR-RUA-037 lists as derived. The oracle revision check
// (M/D) is an admission record frozen before execution, so it is primary; the amendment payload
// records computed from other evidence (operational recovery, billing import) are derived
// (evidence/WP-13/decisions.md).

import { classifyArtifactPath } from '../record-contract/evidence-refs.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type {
  AmendmentKind,
  ArtifactClass,
  ArtifactDerivation,
} from '../record-contract/records/group-c/vocabulary.ts';
import { AMENDMENT_PATHS, EXECUTION_DIRECTORIES, EXECUTION_PATHS, UNIT_PATHS } from './package-layout.ts';
import type { EvidenceUnit } from './package-layout.ts';

/** The class and derivation of one file (design §7 index entry fields). */
export interface ArtifactClassification {
  readonly artifact_class: ArtifactClass;
  readonly derivation: ArtifactDerivation;
}

type UnitKind = EvidenceUnit['kind'];

/** A trial-or-probe file class and the directories that may hold the file. */
export interface UnitFileRule extends ArtifactClassification {
  readonly units: readonly UnitKind[];
}

interface PayloadRule extends ArtifactClassification {
  readonly kinds: readonly AmendmentKind[];
}

const BOTH: readonly UnitKind[] = ['trial', 'probe'];
const TRIAL: readonly UnitKind[] = ['trial'];
const PROBE: readonly UnitKind[] = ['probe'];

function primary(artifactClass: ArtifactClass): ArtifactClassification {
  return { artifact_class: artifactClass, derivation: 'primary' };
}

function derived(artifactClass: ArtifactClass): ArtifactClassification {
  return { artifact_class: artifactClass, derivation: 'derived' };
}

type ExecutionFileKey = Exclude<keyof typeof EXECUTION_PATHS, 'packageIndex'>;
type UnitFileKey = keyof typeof UNIT_PATHS;

/** The class of every execution-level file, by its `EXECUTION_PATHS` key (the package index has none). */
export const EXECUTION_FILE_CLASSES: Readonly<Record<ExecutionFileKey, ArtifactClassification>> = {
  executionManifest: primary('execution_manifest'),
  environmentInput: primary('environment_input'),
  preflightJournal: primary('preflight_journal'),
  sourceProvenance: primary('source_provenance'),
  oracleRevisionCheck: primary('oracle_revision_check'),
  transportScopeSnapshot: primary('transport_scope_snapshot'),
  deploymentAssemblyInventory: primary('deployment_assembly_inventory'),
  coordinationJournal: primary('coordination_journal'),
  coordinationPrefixCheckpoint: primary('coordination_prefix_checkpoint'),
  provisioningJournal: primary('provisioning_journal'),
  resourceManifest: primary('resource_manifest'),
  runnerJournal: primary('runner_journal'),
  canaryCallerJournal: primary('caller_canary_journal'),
  canaryControllerJournal: primary('controller_canary_journal'),
  warmupProviderJournal: primary('provider_warmup_journal'),
  executionProviderJournal: primary('provider_journal'),
  lateEvidenceStream: primary('late_evidence_stream'),
  lateEvidenceAssessment: derived('late_evidence_assessment'),
  preCleanupSnapshot: primary('pre_cleanup_snapshot'),
  cleanupJournal: primary('cleanup_journal'),
  cleanupResult: derived('cleanup_result'),
  leakAuditResult: derived('leak_audit_result'),
  comparisonAssessment: derived('comparison_assessment'),
  safetyAssessment: derived('safety_assessment'),
  runSummary: derived('run_summary'),
  validationSummary: derived('validation_summary'),
  transportProbeSummary: derived('transport_probe_summary'),
};

/** The class of every file of a trial or probe directory, and which of the two may hold it. */
export const UNIT_FILE_CLASSES: Readonly<Record<UnitFileKey, UnitFileRule>> = {
  trialManifest: { ...primary('trial_manifest'), units: TRIAL },
  payment: { ...primary('payment'), units: BOTH },
  approvedDecision: { ...primary('approved_decision'), units: BOTH },
  publishedMessage: { ...primary('published_message'), units: TRIAL },
  providerTrialConfiguration: { ...primary('provider_trial_configuration'), units: BOTH },
  treatmentStateSnapshot: { ...primary('treatment_state_snapshot'), units: BOTH },
  trialRegistration: { ...primary('trial_registration'), units: TRIAL },
  callerJournal: { ...primary('caller_journal'), units: BOTH },
  providerJournal: { ...primary('provider_journal'), units: BOTH },
  controllerJournal: { ...primary('controller_journal'), units: BOTH },
  ledgerSnapshot: { ...primary('ledger_snapshot'), units: BOTH },
  sourceObservations: { ...primary('source_observations'), units: TRIAL },
  dlqObservations: { ...primary('dlq_observations'), units: TRIAL },
  dlqSnapshot: { ...primary('dlq_snapshot'), units: TRIAL },
  settlementSamples: { ...primary('settlement_samples'), units: BOTH },
  durableExecutions: { ...primary('durable_execution_metadata'), units: TRIAL },
  telemetryAvailability: { ...primary('telemetry_availability'), units: BOTH },
  attemptProjection: { ...derived('attempt_projection'), units: BOTH },
  oracleResult: { ...derived('oracle_result'), units: TRIAL },
  transportProbeResult: { ...derived('transport_probe_result'), units: PROBE },
  evidenceIndex: { ...derived('evidence_index'), units: BOTH },
};

const EXECUTION_FILE_RULES: ReadonlyMap<string, ArtifactClassification> = new Map(
  (Object.keys(EXECUTION_FILE_CLASSES) as ExecutionFileKey[]).map((key) => [
    EXECUTION_PATHS[key],
    EXECUTION_FILE_CLASSES[key],
  ]),
);

const UNIT_FILE_RULES: ReadonlyMap<string, UnitFileRule> = new Map(
  (Object.keys(UNIT_FILE_CLASSES) as UnitFileKey[]).map((key) => [UNIT_PATHS[key], UNIT_FILE_CLASSES[key]]),
);

const LATE_KINDS: readonly AmendmentKind[] = ['LATE_EVIDENCE', 'REASSESSMENT'];
const RECOVERY: readonly AmendmentKind[] = ['OPERATIONAL_RECOVERY'];
const BILLING: readonly AmendmentKind[] = ['BILLING'];

const PAYLOAD_RULES: ReadonlyMap<string, PayloadRule> = new Map([
  [AMENDMENT_PATHS.lateEvidenceStream, { ...primary('late_evidence_stream'), kinds: ['LATE_EVIDENCE'] }],
  [AMENDMENT_PATHS.lateEvidenceAssessment, { ...derived('late_evidence_assessment'), kinds: LATE_KINDS }],
  [AMENDMENT_PATHS.operationalRecoveryRecord, { ...derived('operational_recovery_record'), kinds: RECOVERY }],
  [AMENDMENT_PATHS.preCleanupSnapshot, { ...primary('pre_cleanup_snapshot'), kinds: RECOVERY }],
  [AMENDMENT_PATHS.cleanupJournal, { ...primary('cleanup_journal'), kinds: RECOVERY }],
  [AMENDMENT_PATHS.cleanupResult, { ...derived('cleanup_result'), kinds: RECOVERY }],
  [AMENDMENT_PATHS.leakAuditResult, { ...derived('leak_audit_result'), kinds: RECOVERY }],
  [AMENDMENT_PATHS.billingImport, { ...derived('billing_import'), kinds: BILLING }],
]);

const BILLING_EXPORT_RULE: PayloadRule = { ...primary('billing_export_file'), kinds: BILLING };
const SCHEMA_FILE_PATTERN = /^group-[abc]\/[a-z][a-z0-9_]*\.schema\.json$/;
const TRIALS_PREFIX = 'trials/';
const PROBE_PREFIX = 'probe/';

/**
 * Classifies a file of an execution package by its package-relative path (design §7).
 *
 * @example
 * classifyPackageArtifact('trials/<t>/derived/oracle-result.json');
 * // { ok: true, value: { artifact_class: 'oracle_result', derivation: 'derived' } }
 * classifyPackageArtifact('notes.txt'); // { ok: false, error: { code: 'UNCLASSIFIABLE_ARTIFACT_PATH', ... } }
 */
export function classifyPackageArtifact(path: string): Result<ArtifactClassification, StructuredReason> {
  const invalid = invalidPathReason(path);
  if (invalid !== undefined) {
    return err(invalid);
  }
  const rule = EXECUTION_FILE_RULES.get(path) ?? directoryRule(path) ?? unitRule(path);
  return rule === undefined ? err(unclassifiable(path, 'the design §7 package layout')) : ok(rule);
}

/**
 * Classifies a file of an amendment package by its path relative to the amendment directory, and
 * refuses a payload file that the amendment kind does not carry (BR-RUA-043).
 *
 * @example
 * classifyAmendmentPayload('payload/billing-import.json', 'BILLING');
 * // { ok: true, value: { artifact_class: 'billing_import', derivation: 'derived' } }
 */
export function classifyAmendmentPayload(
  path: string,
  kind: AmendmentKind,
): Result<ArtifactClassification, StructuredReason> {
  const invalid = invalidPathReason(path);
  if (invalid !== undefined) {
    return err(invalid);
  }
  const rule = PAYLOAD_RULES.get(path) ?? billingExportRule(path);
  if (rule === undefined) {
    return err(unclassifiable(path, 'the design §7 amendment payload layout'));
  }
  if (!rule.kinds.includes(kind)) {
    return err({
      code: 'PAYLOAD_NOT_ALLOWED_FOR_KIND',
      subject: 'BR-RUA-043',
      artifact_path: path,
      detail: `${boundedJsonText(path)} is a ${rule.kinds.join(' or ')} payload; got amendment kind ${kind}`,
    });
  }
  return ok({ artifact_class: rule.artifact_class, derivation: rule.derivation });
}

/**
 * The BR-RUA-035 reason a path is not a normalized package-relative POSIX path, or `undefined`.
 * The reason never carries the path as `artifact_path`, which must itself be normalized.
 *
 * @example
 * invalidPathReason('../x.json')?.code; // 'INVALID_ARTIFACT_PATH'
 */
export function invalidPathReason(path: string): StructuredReason | undefined {
  const violation = path === '' ? 'EMPTY_PATH' : classifyArtifactPath(path);
  if (violation === undefined) {
    return undefined;
  }
  return {
    code: 'INVALID_ARTIFACT_PATH',
    subject: 'BR-RUA-035',
    detail: `path ${boundedJsonText(path)} is ${violation}; expected a normalized package-relative POSIX path`,
  };
}

function directoryRule(path: string): ArtifactClassification | undefined {
  if (path.startsWith(EXECUTION_DIRECTORIES.schemas)) {
    const rest = path.slice(EXECUTION_DIRECTORIES.schemas.length);
    return SCHEMA_FILE_PATTERN.test(rest) ? primary('schema_file') : undefined;
  }
  // A valid path never ends with `/`, so a path with this prefix names a file inside the assembly.
  return path.startsWith(EXECUTION_DIRECTORIES.deploymentAssembly) ? primary('deployment_assembly_file') : undefined;
}

function unitRule(path: string): ArtifactClassification | undefined {
  const located = locateUnit(path);
  if (located === undefined) {
    return undefined;
  }
  const rule = UNIT_FILE_RULES.get(located.relative);
  if (!rule?.units.includes(located.unit)) {
    return undefined;
  }
  return { artifact_class: rule.artifact_class, derivation: rule.derivation };
}

/**
 * Splits a path into its trial or probe directory and the path inside it; `undefined` when the
 * path lies in neither. A trial directory is named by a lowercase UUIDv4 (BR-RUA-033).
 *
 * @example
 * locateUnit('probe/ledger/ledger-snapshot.json'); // { unit: 'probe', relative: 'ledger/ledger-snapshot.json' }
 */
export function locateUnit(path: string): { readonly unit: UnitKind; readonly relative: string } | undefined {
  if (path.startsWith(PROBE_PREFIX)) {
    return { unit: 'probe', relative: path.slice(PROBE_PREFIX.length) };
  }
  if (!path.startsWith(TRIALS_PREFIX)) {
    return undefined;
  }
  const rest = path.slice(TRIALS_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash !== -1 && isUuid4(rest.slice(0, slash)) ? { unit: 'trial', relative: rest.slice(slash + 1) } : undefined;
}

function billingExportRule(path: string): PayloadRule | undefined {
  // A valid path never ends with `/`, so a path with this prefix names a file inside the export.
  return path.startsWith(AMENDMENT_PATHS.billingExportDirectory) ? BILLING_EXPORT_RULE : undefined;
}

function unclassifiable(path: string, layout: string): StructuredReason {
  return {
    code: 'UNCLASSIFIABLE_ARTIFACT_PATH',
    subject: 'BR-RUA-037',
    artifact_path: path,
    detail: `path ${boundedJsonText(path)} names no artifact class; expected a file of ${layout}`,
  };
}
