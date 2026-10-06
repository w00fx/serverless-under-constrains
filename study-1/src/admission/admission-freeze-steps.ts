// Admission steps A11..A15 (design §10.1, §9.8 S1-S4): declare the identities, synthesize and
// inventory the assembly once, recompute the transport scope, estimate the cost, then build,
// validate and write the package draft with the manifest last. A11..A14 can still reject; A15
// can only fail, when the evidence of an otherwise admissible execution cannot be written.

import { join } from 'node:path';

import { sha256Hex } from '../record-contract/digests.ts';
import type { StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { ExecutionManifest, SchemaFileDigest } from '../record-contract/records/group-a/execution_manifest.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { ExecutionSynthContext } from '../../infra/ownership/execution-context.ts';
import type { PackageFile } from '../evidence-package/package-file-system.ts';
import { EXECUTION_DIRECTORIES, EXECUTION_PATHS, PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import { PRICE_CEILINGS } from '../safety/price-ceilings.ts';
import { SAFETY_REGION, declaredSafetyOf, safetyLimitsFor } from '../safety/safety-limits.ts';
import type { AccountReadiness } from './admission-account-steps.ts';
import type { AdmissionAttempt } from './admission-attempt.ts';
import type { LocalInputs } from './admission-local-steps.ts';
import type { AdmissionOutcome, AdmissionPorts, SchemaCopy } from './admission-ports.ts';
import { admissionReason, portFailureReason } from './admission-reason.ts';
import { synthesizeAssembly } from './assembly-freeze.ts';
import type { SynthesizedAssembly } from './assembly-freeze.ts';
import { assessEstimatedCost } from './cost-check.ts';
import { OR_RUA_002_TIMING, PROVIDER_WARMUP_POLICY, scopeTimingOf } from './declared-inputs.ts';
import { declareExecution } from './execution-identities.ts';
import type { DeclaredExecution } from './execution-identities.ts';
import { buildExecutionManifest } from './execution-manifest-builder.ts';
import { draftFiles, recordFileSha256, writePackageDraft } from './package-draft.ts';
import type { AdmittedScope } from './scope-check.ts';
import { assessTransportScope } from './scope-check.ts';
import { sourceProvenanceRecord } from './source-provenance.ts';

/** Everything A2..A14 admitted. */
export type AdmittedChecks = LocalInputs & AccountReadiness;

interface FrozenParts {
  readonly declared: DeclaredExecution;
  readonly assembly: SynthesizedAssembly;
  readonly scope: AdmittedScope;
  readonly manifest_input: Pick<ExecutionManifest, 'estimates'>;
  readonly frozen_at: UtcMillis;
}

/**
 * Steps A11..A15.
 *
 * @example
 * return freezeAdmittedExecution({ ...local.value, ...account.value }, ports, attempt);
 */
export async function freezeAdmittedExecution(
  admitted: AdmittedChecks,
  ports: AdmissionPorts,
  attempt: AdmissionAttempt,
): Promise<AdmissionOutcome> {
  const { target } = admitted.inputs;
  const limits = safetyLimitsFor(target.kind);
  const variant = target.kind === 'VARIANT_VALIDATION' ? { variant_id: target.variant } : {};
  const declared = await attempt.record(
    'A11',
    declareExecution(target, attempt.admission_attempt_id, admitted.selected?.selection ?? null, ports.ids),
  );
  if (declared.kind === 'stop') {
    return declared.outcome;
  }
  const admittedAt = formatUtcMillis(ports.clock.now());
  const context: ExecutionSynthContext = {
    execution_kind: target.kind,
    execution_id: declared.value.execution_id,
    account: admitted.environment.account_id,
    region: SAFETY_REGION,
    admitted_at: admittedAt,
    total_target_ms: limits.total_ms,
    ...variant,
  };
  const stagingDir = join(ports.paths.staging_root, attempt.admission_attempt_id);
  const assembly = await attempt.record('A12', await synthesizeAssembly(context, stagingDir, ports, admittedAt));
  if (assembly.kind === 'stop') {
    return assembly.outcome;
  }
  const scopeEnvironment = {
    template: assembly.value.template,
    runtime: {},
    timing: scopeTimingOf(OR_RUA_002_TIMING),
    provider_warmup: PROVIDER_WARMUP_POLICY,
  };
  const scope = await attempt.record(
    'A13',
    await assessTransportScope(scopeEnvironment, ports.scope, admitted.selected),
  );
  if (scope.kind === 'stop') {
    return scope.outcome;
  }
  const estimates = await attempt.record(
    'A14',
    assessEstimatedCost({
      kind: target.kind,
      ...variant,
      limits,
      treatment_poll_interval_ms: OR_RUA_002_TIMING.treatment_poll_interval_ms,
      prices: PRICE_CEILINGS,
    }),
  );
  if (estimates.kind === 'stop') {
    return estimates.outcome;
  }
  const parts: FrozenParts = {
    declared: declared.value,
    assembly: assembly.value,
    scope: scope.value,
    manifest_input: { estimates: estimates.value },
    frozen_at: formatUtcMillis(ports.clock.now()),
  };
  return writeAdmittedPackage(admitted, parts, ports, attempt);
}

// A15: build and validate every record, record the step, finalize the attempt journal, then write
// the draft with the manifest last.
async function writeAdmittedPackage(
  admitted: AdmittedChecks,
  parts: FrozenParts,
  ports: AdmissionPorts,
  attempt: AdmissionAttempt,
): Promise<AdmissionOutcome> {
  const catalog = await ports.schemas.readSchemaCatalog();
  if (!catalog.ok) {
    return attempt.fail([
      portFailureReason('SCHEMA_CATALOG_UNREADABLE', 'BR-RUA-040', 'the schema catalogue read', catalog.error),
    ]);
  }
  const draft = buildDraft(admitted, parts, catalog.value, attempt, ports);
  if (!draft.ok) {
    return attempt.fail(draft.error);
  }
  const recorded = await attempt.record('A15', {
    passed: true,
    value: null,
    statement: { subject: 'execution_manifest', expected: 'frozen_manifest', observed: draft.value.manifest_sha256 },
  });
  if (recorded.kind === 'stop') {
    return recorded.outcome;
  }
  const problem =
    (await attempt.finalize()) ??
    (await writePackageDraft(
      {
        evidence_root: ports.paths.evidence_root,
        identity: parts.declared.identity,
        draft: draft.value,
        assembly: parts.assembly,
        journal_bytes: attempt.journalBytes(),
      },
      ports.files,
    ));
  if (problem !== undefined) {
    return attempt.fail([problem]);
  }
  return {
    kind: 'admitted',
    admission_attempt_id: attempt.admission_attempt_id,
    manifest_path: `${PACKAGE_LAYOUT.executionDirectory(parts.declared.identity)}/${EXECUTION_PATHS.executionManifest}`,
    manifest_sha256: draft.value.manifest_sha256,
    execution: parts.declared.identity,
  };
}

function buildDraft(
  admitted: AdmittedChecks,
  parts: FrozenParts,
  catalog: readonly SchemaCopy[],
  attempt: AdmissionAttempt,
  ports: AdmissionPorts,
): ReturnType<typeof draftFiles> {
  const [firstSchema, ...moreSchemas] = catalog.map(schemaDigest);
  if (firstSchema === undefined) {
    return { ok: false, error: [emptyCatalog()] };
  }
  const { environment, source, capabilities } = admitted;
  const provenance = sourceProvenanceRecord(
    attempt.admission_attempt_id,
    source,
    capabilities.tool_versions,
    parts.frozen_at,
  );
  const manifest = buildExecutionManifest({
    admission_attempt_id: attempt.admission_attempt_id,
    frozen_at: parts.frozen_at,
    execution: parts.declared,
    financial_inputs: admitted.inputs.financial_inputs,
    safety: declaredSafetyOf(safetyLimitsFor(parts.declared.identity.execution_kind)),
    environment: {
      environment_input_sha256: environment.sha256,
      account_id: environment.account_id,
      region: SAFETY_REGION,
      coordination_table_arn: environment.input.coordination_table_arn,
      coordination_stack_id: environment.input.coordination_stack_id,
      coordination_schema_version: environment.input.expected_coordination_schema_version,
    },
    source: {
      commit_sha: source.commit_sha,
      tree_sha: source.tree_sha,
      ...(source.branch === undefined ? {} : { branch: source.branch }),
      clean_confirmed: true,
      lockfile_sha256: source.lockfile_sha256,
      tool_versions: capabilities.tool_versions,
      source_provenance_sha256: recordFileSha256(provenance),
    },
    schema_files: [firstSchema, ...moreSchemas],
    transport_scope_snapshot_sha256: parts.scope.sha256,
    deployment_assembly: {
      assembly_path: parts.assembly.inventory.assembly_path,
      inventory_sha256: parts.assembly.inventory.inventory_sha256,
      template_path: parts.assembly.template_path,
      template_sha256: parts.assembly.template_sha256,
    },
    estimates: parts.manifest_input.estimates,
  });
  return draftFiles(
    [
      { path: EXECUTION_PATHS.sourceProvenance, record_type: 'source_provenance', record: provenance },
      { path: EXECUTION_PATHS.oracleRevisionCheck, record_type: 'oracle_revision_check', record: admitted.oracle },
      {
        path: EXECUTION_PATHS.transportScopeSnapshot,
        record_type: 'transport_scope_snapshot',
        record: parts.scope.snapshot,
      },
    ],
    [{ path: EXECUTION_PATHS.environmentInput, bytes: environment.bytes }, ...catalog.map(schemaFile)],
    manifest,
    ports.validator,
  );
}

function schemaDigest(copy: SchemaCopy): SchemaFileDigest {
  return { record_type: copy.record_type, relative_path: copy.relative_path, sha256: sha256Hex(copy.bytes) };
}

function schemaFile(copy: SchemaCopy): PackageFile {
  return { path: `${EXECUTION_DIRECTORIES.schemas}${copy.relative_path}`, bytes: copy.bytes };
}

function emptyCatalog(): StructuredReason {
  return admissionReason(
    'SCHEMA_CATALOG_EMPTY',
    'BR-RUA-040',
    'the schema catalogue lists no schema; expected every record schema',
  );
}
