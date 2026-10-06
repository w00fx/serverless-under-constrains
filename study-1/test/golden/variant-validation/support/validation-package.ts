// A complete variant-validation package built with the production code, for the WP-17 goldens:
// admission files, the two declared trials (each frozen with its evidence index unless the scenario
// says it never froze), the closure and late-evidence records, the safety assessment, the summary
// from `buildValidationSummary` and the final package index from `buildPackageIndex`. The terminal
// reason comes from `deriveValidationTerminalReason` over the scenario's runner events. Files the verifier never interprets (journals, ledger,
// inputs, cleanup and leak-audit results) are small placeholders the references can pin.

import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { ExecutionIdentity, Sha256Hex, VariantId } from '../../../../src/record-contract/primitives.ts';
import type { DeclaredTrial } from '../../../../src/record-contract/records/group-a/execution_manifest.ts';
import type { PhaseTransitionRecorded } from '../../../../src/record-contract/records/group-b/phase_transition_recorded.ts';
import type { LateEvidenceAssessment } from '../../../../src/record-contract/records/group-c/late_evidence_assessment.ts';
import type { OperationalClosure } from '../../../../src/record-contract/records/group-c/operational_recovery_record.ts';
import type { SafetyAssessment } from '../../../../src/record-contract/records/group-c/safety_assessment.ts';
import type { ValidationSummary } from '../../../../src/record-contract/records/group-c/validation_summary.ts';
import { inventoryAssembly } from '../../../../src/evidence-package/assembly-inventory.ts';
import { buildEvidenceIndex } from '../../../../src/evidence-package/evidence-index.ts';
import { buildPackageIndex } from '../../../../src/evidence-package/package-index.ts';
import type { PackageFile } from '../../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../../src/evidence-package/package-layout.ts';
import { readAdmissionEvidence } from '../../../../src/variant-validation/admission-evidence.ts';
import { buildValidationSummary } from '../../../../src/variant-validation/validation-summary.ts';
import type { ValidationTrialOutcome } from '../../../../src/variant-validation/validation-summary.ts';
import { deriveValidationTerminalReason } from '../../../../src/variant-validation/validation-terminal-reason.ts';
import { environmentInput } from '../../../contract/record-contract/group-a/support/input-examples.ts';
import { validationResourceManifest } from '../../../contract/record-contract/group-a/support/branch-examples.ts';
import { FIXTURE_DEPS, FIXTURE_VALIDATOR, unwrap } from '../../../support/evidence-package/probe-package-fixtures.ts';
import { executionEnvelope } from '../../../support/record-contract/record-builders.ts';
import {
  GOLDEN_VALIDATION_ID,
  controlOracleResult,
  goldenAt,
  goldenManifest,
  goldenProvenance,
  goldenRevisionCheck,
  goldenTrialManifest,
  treatmentOracleResult,
  validated,
} from './validation-records.ts';
import type { ControlResultKind, TreatmentResultKind } from './validation-records.ts';
import { encoder, fileAtPath, jsonFile, placeholder, recordFile, refTo, toJsonValue } from './golden-files.ts';

export const GOLDEN_IDENTITY: ExecutionIdentity = {
  execution_kind: 'VARIANT_VALIDATION',
  variant_validation_id: GOLDEN_VALIDATION_ID,
};

/** A clean closure: cleanup succeeded, audit clean, lease released. */
export const CLEAN_CLOSURE: OperationalClosure = {
  cleanup_status: 'succeeded',
  leak_audit_status: 'clean',
  lease_status: 'released',
};

/** What a golden validation looks like; every member defaults to the sound, verified validation. */
export interface ValidationScenario {
  readonly variant: VariantId;
  readonly control: ControlResultKind;
  /** `not_frozen`: the treatment trial was interrupted before its evidence could be frozen. */
  readonly treatment: TreatmentResultKind | 'not_frozen';
  readonly closure: OperationalClosure;
  readonly revision_check: 'passed' | 'failed';
  /** The treatment's oracle result names another execution manifest than the frozen one. */
  readonly treatment_manifest_drift: boolean;
}

const SOUND_SCENARIO: ValidationScenario = {
  variant: 'durable',
  control: 'pass',
  treatment: 'pass',
  closure: CLEAN_CLOSURE,
  revision_check: 'passed',
  treatment_manifest_drift: false,
};

/** A built package, the digest of its final index, and its summary as frozen. */
export interface GoldenPackage {
  readonly files: readonly PackageFile[];
  readonly index_sha256: Sha256Hex;
  readonly manifest_sha256: Sha256Hex;
  readonly summary: ValidationSummary;
}

const TRIAL_PLACEHOLDERS = [
  'inputs/payment.json',
  'inputs/approved-decision.json',
  'journals/caller-journal.jsonl',
  'journals/provider-journal.jsonl',
  'journals/controller-journal.jsonl',
  'ledger/ledger-snapshot.json',
  'settlement/settlement-samples.jsonl',
] as const;

/**
 * Builds the package of a scenario.
 *
 * @example
 * const sound = validationPackage(); // control pass, treatment pass, clean closure
 * const repaired = validationPackage({ closure: { ...CLEAN_CLOSURE, cleanup_status: 'partial' } });
 */
export function validationPackage(overrides: Partial<ValidationScenario> = {}): GoldenPackage {
  const scenario: ValidationScenario = { ...SOUND_SCENARIO, ...overrides };
  const provenance = recordFile(EXECUTION_PATHS.sourceProvenance, goldenProvenance());
  const manifest = goldenManifest(scenario.variant, sha256Hex(provenance.bytes));
  const manifestFile = recordFile(EXECUTION_PATHS.executionManifest, manifest);
  const manifestDigest = sha256Hex(manifestFile.bytes);
  const admission: PackageFile[] = [
    manifestFile,
    provenance,
    recordFile(EXECUTION_PATHS.environmentInput, environmentInput()),
    recordFile(EXECUTION_PATHS.oracleRevisionCheck, goldenRevisionCheck(scenario.revision_check)),
    jsonFile(EXECUTION_PATHS.resourceManifest, validationResourceManifest()),
    ...assemblyFiles(),
    placeholder(EXECUTION_PATHS.runnerJournal),
  ];
  const [control, treatment] = manifest.trials;
  const controlTrial = frozenTrial(admission, control, manifestDigest, (identity) =>
    controlOracleResult(scenario.control, identity),
  );
  const treatmentTrial =
    scenario.treatment === 'not_frozen'
      ? interruptedTrial(treatment, manifestDigest)
      : frozenTrial(
          admission,
          treatment,
          scenario.treatment_manifest_drift ? sha256Hex(encoder.encode('drift')) : manifestDigest,
          (identity) => treatmentOracleResult(scenario.treatment as TreatmentResultKind, identity),
        );
  const cleanupResult = placeholder(EXECUTION_PATHS.cleanupResult);
  const closureFiles = [
    placeholder(EXECUTION_PATHS.lateEvidenceStream),
    cleanupResult,
    placeholder(EXECUTION_PATHS.leakAuditResult),
  ];
  const lateAssessment = recordFile(EXECUTION_PATHS.lateEvidenceAssessment, lateEvidenceAssessment(manifestDigest));
  const safety = safetyAssessment(manifestDigest, [...admission]);
  const summary = buildValidationSummary({
    manifest,
    execution_manifest_sha256: manifestDigest,
    trials: [controlTrial.outcome, treatmentTrial.outcome],
    scientific_defects: unwrap(readAdmissionEvidence(admission, GOLDEN_VALIDATION_ID, FIXTURE_DEPS)).defects,
    terminal_reason: deriveValidationTerminalReason(
      scenario.treatment === 'not_frozen' ? [trialsPhaseFailed(manifestDigest)] : [],
      scenario.closure,
    ),
    closure: scenario.closure,
    safety,
    evidence_integrity_status: 'verified',
    late_evidence_status: 'none',
    cleanup_result_ref: refTo(cleanupResult),
    late_evidence_assessment_ref: refTo(lateAssessment),
    created_at: goldenAt(9000),
  });
  const content = [
    ...admission,
    ...controlTrial.files,
    ...treatmentTrial.files,
    ...closureFiles,
    lateAssessment,
    recordFile(EXECUTION_PATHS.safetyAssessment, safety),
    recordFile(EXECUTION_PATHS.validationSummary, summary),
  ];
  validated(toJsonValue(summary), 'validation_summary', FIXTURE_VALIDATOR);
  return indexedPackage(content, manifestDigest, summary);
}

/**
 * The package with its files replaced by `files` and a final index rebuilt over them, as a writer
 * that froze exactly these bytes would have written it; the summary stays the one given.
 *
 * @example
 * const altered = reindexed(fixture, withoutFile(fixture.files, 'summary/safety-assessment.json'));
 */
export function reindexed(fixture: GoldenPackage, files: readonly PackageFile[]): GoldenPackage {
  const content = files.filter((file) => file.path !== EXECUTION_PATHS.packageIndex);
  return indexedPackage(content, fixture.manifest_sha256, fixture.summary);
}

function indexedPackage(
  content: readonly PackageFile[],
  manifestDigest: Sha256Hex,
  summary: ValidationSummary,
): GoldenPackage {
  const index = unwrap(buildPackageIndex({ files: content, identity: GOLDEN_IDENTITY, created_at: goldenAt(9100) }));
  const indexFile = recordFile(EXECUTION_PATHS.packageIndex, index);
  return {
    files: [...content, indexFile],
    index_sha256: sha256Hex(indexFile.bytes),
    manifest_sha256: manifestDigest,
    summary,
  };
}

interface BuiltTrial {
  readonly files: readonly PackageFile[];
  readonly outcome: ValidationTrialOutcome;
}

function frozenTrial(
  admission: readonly PackageFile[],
  trial: DeclaredTrial,
  resultManifestDigest: Sha256Hex,
  oracle: (identity: Parameters<typeof controlOracleResult>[1]) => ReturnType<typeof controlOracleResult>,
): BuiltTrial {
  const unit = { kind: 'trial', trial_id: trial.trial_id } as const;
  const inputs = TRIAL_PLACEHOLDERS.map((path) => placeholder(`${PACKAGE_LAYOUT.unitDirectory(unit)}/${path}`));
  const digestOf = (path: string): Sha256Hex =>
    sha256Hex(inputs.find((file) => file.path === path)?.bytes ?? new Uint8Array());
  const manifestDigest = sha256Hex(fileAtPath(admission, EXECUTION_PATHS.executionManifest).bytes);
  const trialManifest = recordFile(
    PACKAGE_LAYOUT.unitFile(unit, 'trialManifest'),
    goldenTrialManifest(trial, manifestDigest, digestOf),
  );
  const stored = [...inputs, trialManifest];
  const result = oracle({
    trial,
    execution_manifest_sha256: resultManifestDigest,
    trial_manifest_sha256: sha256Hex(trialManifest.bytes),
    files: stored,
    validator: FIXTURE_VALIDATOR,
  });
  const resultFile = recordFile(PACKAGE_LAYOUT.unitFile(unit, 'oracleResult'), result);
  const index = unwrap(
    buildEvidenceIndex({
      files: [...admission, ...stored, resultFile],
      target: {
        index_scope: 'TRIAL',
        execution: GOLDEN_IDENTITY as Extract<ExecutionIdentity, { execution_kind: 'VARIANT_VALIDATION' }>,
        trial_id: trial.trial_id,
      },
      created_at: goldenAt(5000 + trial.sequence),
    }),
  );
  return {
    files: [...stored, resultFile, recordFile(PACKAGE_LAYOUT.unitFile(unit, 'evidenceIndex'), index)],
    outcome: {
      kind: 'evaluated',
      execution_status: 'completed',
      incompletion_reasons: [],
      oracle_result: result,
      oracle_result_ref: refTo(resultFile),
      trial_manifest_sha256: sha256Hex(trialManifest.bytes),
      anchor_problems: [],
    },
  };
}

function interruptedTrial(trial: DeclaredTrial, manifestDigest: Sha256Hex): BuiltTrial {
  const unit = { kind: 'trial', trial_id: trial.trial_id } as const;
  const inputs = TRIAL_PLACEHOLDERS.slice(0, 2).map((path) =>
    placeholder(`${PACKAGE_LAYOUT.unitDirectory(unit)}/${path}`),
  );
  const digestOf = (path: string): Sha256Hex =>
    sha256Hex(inputs.find((file) => file.path === path)?.bytes ?? new Uint8Array());
  return {
    files: [
      ...inputs,
      recordFile(PACKAGE_LAYOUT.unitFile(unit, 'trialManifest'), goldenTrialManifest(trial, manifestDigest, digestOf)),
    ],
    outcome: {
      kind: 'unevaluated',
      execution_status: 'incomplete',
      incompletion_reasons: [
        {
          code: 'TRIAL_NOT_FROZEN',
          subject: `trial ${trial.trial_id}`,
          detail: 'the trial was interrupted before its evidence was frozen',
        },
      ],
    },
  };
}

function trialsPhaseFailed(manifestDigest: Sha256Hex): PhaseTransitionRecorded {
  return {
    ...executionEnvelope('phase_transition_recorded', 'validation', 0x1720, 7),
    variant_validation_id: GOLDEN_VALIDATION_ID,
    execution_manifest_sha256: manifestDigest,
    source: 'runner',
    phase: 'TRIALS',
    status: 'failed',
    reasons: [{ code: 'TRIAL_NOT_FROZEN', subject: 'TRIALS', detail: 'trial 2 was interrupted before freeze' }],
  };
}

function lateEvidenceAssessment(manifestDigest: Sha256Hex): LateEvidenceAssessment {
  return {
    schema_version: 1,
    record_type: 'late_evidence_assessment',
    variant_validation_id: GOLDEN_VALIDATION_ID,
    execution_manifest_sha256: manifestDigest,
    monitoring: 'complete',
    late_evidence_status: 'none',
    monitoring_started_at: goldenAt(7000),
    monitoring_ended_at: goldenAt(67_000),
    correlated_record_count: 0,
    reassessments: [],
    reasons: [],
    evidence_refs: [refTo(placeholder(EXECUTION_PATHS.lateEvidenceStream))],
    assessed_at: goldenAt(67_100),
  };
}

function safetyAssessment(manifestDigest: Sha256Hex, admission: readonly PackageFile[]): SafetyAssessment {
  const runner = [refTo(fileAtPath(admission, EXECUTION_PATHS.runnerJournal))];
  const manifest = [refTo(fileAtPath(admission, EXECUTION_PATHS.executionManifest))];
  return {
    schema_version: 1,
    record_type: 'safety_assessment',
    variant_validation_id: GOLDEN_VALIDATION_ID,
    execution_manifest_sha256: manifestDigest,
    safety_status: 'within_limits',
    checks: [
      {
        boundary: 'ESTIMATED_COST',
        declared_limit: '5.00 USD',
        observed: '1.25 USD',
        result: 'within_limits',
        evidence_refs: manifest,
        checked_at: goldenAt(1000),
      },
      {
        boundary: 'ACTIVE_TIME',
        declared_limit: '4500000 ms',
        observed: '1200000 ms',
        result: 'within_limits',
        evidence_refs: runner,
        checked_at: goldenAt(4000),
      },
      {
        boundary: 'TOTAL_TIME',
        declared_limit: '5400000 ms',
        observed: '1500000 ms',
        result: 'within_limits',
        evidence_refs: runner,
        checked_at: goldenAt(8800),
      },
    ],
    reasons: [],
    assessed_at: goldenAt(8900),
  };
}

function assemblyFiles(): readonly PackageFile[] {
  const relative: readonly PackageFile[] = [
    { path: 'manifest.json', bytes: encoder.encode('{"version":"48.0.0","artifacts":{}}\n') },
    {
      path: 'asset.0001/index.mjs',
      bytes: encoder.encode('export const handler = async () => ({ statusCode: 200 });\n'),
    },
  ];
  const inventory = unwrap(
    inventoryAssembly({
      assembly_path: 'admission/deployment-assembly',
      entries: [
        { path: 'asset.0001', type: 'directory', mode: 0o040755 },
        ...relative.map((file) => ({ path: file.path, type: 'file' as const, mode: 0o100644 })),
      ],
      files: relative,
      inventoried_at: goldenAt(500),
    }),
  );
  return [
    ...relative.map((file) => ({ path: `admission/deployment-assembly/${file.path}`, bytes: file.bytes })),
    recordFile(EXECUTION_PATHS.deploymentAssemblyInventory, inventory),
  ];
}
