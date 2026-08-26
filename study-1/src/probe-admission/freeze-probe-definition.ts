import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { admitProbeAttempt } from "./admit-probe-attempt.ts";
import { serializeCanonicalJson, sha256Bytes } from "./canonical-json.ts";
import {
  formatUtcTimestamp,
  isCanonicalRecordType,
  isCanonicalUtcMillisecondTimestamp,
  isLowercaseUuidV4,
  resolveLowercaseUuidV4,
  TerminalProbeIdentityError,
} from "./identity.ts";
import {
  CLOCK_ASSUMPTION_CA1,
  EXPECTED_FIDELITY_BASIS,
  EXPECTED_TQ_CONDITION_IDS,
  PROBE_TIMING,
  TQ_DEFINITIONS,
} from "./protocol.ts";
import type {
  ProbeAdmissionDependencies,
  ProbeAttemptProposal,
  ProbeFreezeResult,
  RejectionReason,
} from "./types.ts";
import {
  ALLOWED_CURRENCY,
  ALLOWED_REGION,
  EXPECTED_COORDINATION_SCHEMA_VERSION,
  FIDELITY_BASIS,
  MAX_SAFE_AMOUNT_MINOR,
  PROBE_ACTIVE_TIME_SECONDS,
  PROBE_RESERVED_CLEANUP_SECONDS,
  PROBE_STABILIZATION_INTERVAL_SECONDS,
  PROBE_TOTAL_TARGET_SECONDS,
  PROBE_USAGE_CEILING_USD_MINOR,
  RETRY_JITTER,
  SCHEMA_VERSION,
  SHA256_HEX_PATTERN,
} from "./types.ts";
import { isNormalizedRelativePosixPath, isPlainObject } from "./value-guards.ts";

const SCHEMA_DIR = fileURLToPath(new URL("./schemas/", import.meta.url));
const SCHEMA_PATH_PREFIX = "src/probe-admission/schemas/";
const MANIFEST_RECORD_TYPE = "transport_probe_manifest";
const MANIFEST_FILE_NAME = "transport-probe-manifest.json";
const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/;

export class FrozenArtifactError extends Error {
  readonly transport_probe_id: string;
  readonly manifest_path: string;

  constructor(transportProbeId: string, manifestPath: string) {
    super("frozen artifact is immutable");
    this.name = "FrozenArtifactError";
    this.transport_probe_id = transportProbeId;
    this.manifest_path = manifestPath;
  }
}

export class ProbeManifestValidationError extends Error {
  readonly reasons: RejectionReason[];

  constructor(reasons: RejectionReason[]) {
    super("probe manifest failed canonical validation");
    this.name = "ProbeManifestValidationError";
    this.reasons = reasons;
  }
}

export async function freezeProbeDefinition(
  proposal: ProbeAttemptProposal,
  deps: ProbeAdmissionDependencies,
): Promise<ProbeFreezeResult> {
  const probeAttemptId = resolveLowercaseUuidV4(deps.createId);
  const rejectionDir = join(deps.evidenceRoot, "probe-attempts", probeAttemptId);
  const manifestPathForId = join(
    deps.evidenceRoot,
    "transport-probes",
    probeAttemptId,
    MANIFEST_FILE_NAME,
  );
  if (await exists(manifestPathForId)) {
    throw new FrozenArtifactError(probeAttemptId, manifestPathForId);
  }
  if (await exists(rejectionDir)) {
    throw new TerminalProbeIdentityError(probeAttemptId, "rejected");
  }

  const admission = await admitProbeAttempt(proposal, {
    ...deps,
    createId: () => probeAttemptId,
  });
  if (admission.status === "rejected") {
    return admission;
  }

  const frozenAt = formatUtcTimestamp((deps.now ?? (() => new Date()))());
  const manifest = await buildProbeManifest(
    admission.probe_attempt_id,
    frozenAt,
    proposal,
  );
  const { bytes, sha256 } = serializeProbeManifest(manifest);
  const manifestPath = await persistFrozenManifest(
    deps.evidenceRoot,
    admission.probe_attempt_id,
    bytes,
  );

  return {
    status: "frozen",
    transport_probe_id: admission.probe_attempt_id,
    probe_attempt_id: admission.probe_attempt_id,
    manifest_path: manifestPath,
    manifest_sha256: sha256,
  };
}

export function serializeProbeManifest(manifest: unknown): {
  bytes: string;
  sha256: string;
} {
  const reasons = validateProbeManifest(manifest);
  if (reasons.length > 0) {
    throw new ProbeManifestValidationError(reasons);
  }
  const bytes = serializeCanonicalJson(manifest);
  return { bytes, sha256: sha256Bytes(bytes) };
}

export function validateProbeManifest(manifest: unknown): RejectionReason[] {
  if (!isPlainObject(manifest)) {
    return [
      {
        code: "manifest_not_object",
        category: "configuration",
        expected: "object",
        observed: manifest,
      },
    ];
  }

  const reasons: RejectionReason[] = [];
  reasons.push(
    ...recordHeaderReasons(manifest, MANIFEST_RECORD_TYPE),
    ...uuidFieldReasons(manifest, "transport_probe_id"),
    ...uuidFieldReasons(manifest, "probe_attempt_id"),
    ...timestampFieldReasons(manifest, "frozen_at"),
  );

  if (
    typeof manifest.transport_probe_id === "string" &&
    typeof manifest.probe_attempt_id === "string" &&
    isLowercaseUuidV4(manifest.transport_probe_id) &&
    isLowercaseUuidV4(manifest.probe_attempt_id) &&
    manifest.transport_probe_id !== manifest.probe_attempt_id
  ) {
    reasons.push({
      code: "transport_probe_id_mismatch",
      category: "configuration",
      expected: manifest.probe_attempt_id,
      observed: manifest.transport_probe_id,
    });
  }

  if (!isPlainObject(manifest.payment)) {
    reasons.push({
      code: "invalid_record_type",
      category: "configuration",
      expected: "payment",
      observed: manifest.payment,
    });
  } else {
    reasons.push(
      ...recordHeaderReasons(manifest.payment, "payment"),
      ...paymentEvidenceReasons(manifest.payment),
    );
  }

  if (!isPlainObject(manifest.approved_decision)) {
    reasons.push({
      code: "invalid_record_type",
      category: "configuration",
      expected: "approved_decision",
      observed: manifest.approved_decision,
    });
  } else {
    reasons.push(
      ...recordHeaderReasons(manifest.approved_decision, "approved_decision"),
      ...approvedDecisionEvidenceReasons(manifest.approved_decision),
    );
  }

  if (isPlainObject(manifest.payment) && isPlainObject(manifest.approved_decision)) {
    reasons.push(
      ...linkedFinancialReasons(manifest.payment, manifest.approved_decision),
    );
  }

  if (!isPlainObject(manifest.clock_assumption)) {
    reasons.push({
      code: "invalid_record_type",
      category: "configuration",
      expected: "clock_assumption",
      observed: manifest.clock_assumption,
    });
  } else {
    reasons.push(
      ...recordHeaderReasons(manifest.clock_assumption, "clock_assumption"),
    );
    if (manifest.clock_assumption.assumption_id !== "CA-1") {
      reasons.push({
        code: "clock_assumption_id_invalid",
        category: "configuration",
        expected: "CA-1",
        observed: manifest.clock_assumption.assumption_id,
      });
    }
    if (manifest.clock_assumption.assumption_type !== "clock_alignment") {
      reasons.push({
        code: "clock_assumption_type_invalid",
        category: "configuration",
        expected: "clock_alignment",
        observed: manifest.clock_assumption.assumption_type,
      });
    }
    if (manifest.clock_assumption.status !== "declared_not_service_guaranteed") {
      reasons.push({
        code: "clock_assumption_status_invalid",
        category: "configuration",
        expected: "declared_not_service_guaranteed",
        observed: manifest.clock_assumption.status,
      });
    }
    if (manifest.clock_assumption.scope !== CLOCK_ASSUMPTION_CA1.scope) {
      reasons.push({
        code: "clock_assumption_scope_invalid",
        category: "configuration",
        expected: CLOCK_ASSUMPTION_CA1.scope,
        observed: manifest.clock_assumption.scope,
      });
    }
    if (manifest.clock_assumption.statement !== CLOCK_ASSUMPTION_CA1.statement) {
      reasons.push({
        code: "clock_assumption_statement_invalid",
        category: "configuration",
        expected: CLOCK_ASSUMPTION_CA1.statement,
        observed: manifest.clock_assumption.statement,
      });
    }
  }

  if (manifest.fidelity_basis !== EXPECTED_FIDELITY_BASIS) {
    reasons.push({
      code: "fidelity_basis_invalid",
      category: "configuration",
      expected: EXPECTED_FIDELITY_BASIS,
      observed: manifest.fidelity_basis,
    });
  }

  if (!isStringArrayEqual(manifest.clock_assumption_refs, ["CA-1"])) {
    reasons.push({
      code: "clock_assumption_refs_invalid",
      category: "configuration",
      expected: ["CA-1"],
      observed: manifest.clock_assumption_refs,
    });
  }

  if (!isPlainObject(manifest.timing)) {
    reasons.push({
      code: "timing_invalid",
      category: "configuration",
      expected: PROBE_TIMING,
      observed: manifest.timing,
    });
  } else {
    reasons.push(...timingContractReasons(manifest.timing));
  }

  reasons.push(...requiredManifestBlockReasons(manifest));
  reasons.push(...tqDefinitionReasons(manifest.tq_definitions));
  reasons.push(...schemaDigestReasons(manifest.schema_digests));

  if (!Array.isArray(manifest.selected_predecessor_probe_ids)) {
    reasons.push({
      code: "selected_predecessor_probe_ids_invalid",
      category: "configuration",
      expected: [],
      observed: manifest.selected_predecessor_probe_ids,
    });
  } else if (
    manifest.selected_predecessor_probe_ids.some(
      (value) => typeof value !== "string" || !isLowercaseUuidV4(value),
    )
  ) {
    reasons.push({
      code: "identifier_not_lowercase_uuid_v4",
      category: "configuration",
      expected: "lowercase UUIDv4",
      observed: manifest.selected_predecessor_probe_ids,
    });
  }

  if (
    typeof manifest.environment_input_sha256 !== "string" ||
    !SHA256_HEX_PATTERN.test(manifest.environment_input_sha256)
  ) {
    reasons.push({
      code: "digest_invalid",
      category: "configuration",
      expected: "lowercase SHA-256 hex",
      observed: manifest.environment_input_sha256,
    });
  }

  return reasons;
}

async function buildProbeManifest(
  transportProbeId: string,
  frozenAt: string,
  proposal: ProbeAttemptProposal,
): Promise<Record<string, unknown>> {
  const environment = {
    allowlisted_account_id: proposal.environment.allowlisted_account_id,
    coordination_resource_arn: proposal.environment.coordination_resource_arn,
    coordination_stack_identity: proposal.environment.coordination_stack_identity,
    expected_coordination_schema_version:
      proposal.environment.expected_coordination_schema_version,
  };

  return {
    schema_version: SCHEMA_VERSION,
    record_type: MANIFEST_RECORD_TYPE,
    transport_probe_id: transportProbeId,
    probe_attempt_id: transportProbeId,
    frozen_at: frozenAt,
    payment: {
      schema_version: SCHEMA_VERSION,
      record_type: "payment",
      payment_id: proposal.payment.payment_id,
      captured_amount_minor: proposal.payment.captured_amount_minor,
      currency: proposal.payment.currency,
    },
    approved_decision: {
      schema_version: SCHEMA_VERSION,
      record_type: "approved_decision",
      refund_request_id: proposal.approved_decision.refund_request_id,
      payment_id: proposal.approved_decision.payment_id,
      decision: proposal.approved_decision.decision,
      approved_amount_minor: proposal.approved_decision.approved_amount_minor,
      currency: proposal.approved_decision.currency,
    },
    timing: { ...PROBE_TIMING },
    safety: {
      region: ALLOWED_REGION,
      active_probe_time_seconds: PROBE_ACTIVE_TIME_SECONDS,
      reserved_cleanup_seconds: PROBE_RESERVED_CLEANUP_SECONDS,
      total_target_seconds: PROBE_TOTAL_TARGET_SECONDS,
      estimated_attributable_usage_usd_minor:
        proposal.safety.estimated_attributable_usage_usd_minor,
      stabilization_interval_seconds: PROBE_STABILIZATION_INTERVAL_SECONDS,
      ownership_strategy: proposal.safety.ownership_strategy,
    },
    clock_assumption: { ...CLOCK_ASSUMPTION_CA1 },
    clock_assumption_refs: ["CA-1"],
    fidelity_basis: FIDELITY_BASIS,
    tq_definitions: TQ_DEFINITIONS.map((definition) => ({ ...definition })),
    source: {
      head_revision: proposal.source.head_revision,
      lockfile_present: proposal.source.lockfile_present,
      lockfile_tracked: proposal.source.lockfile_tracked,
    },
    tools: {
      node_version: proposal.tools.node_version,
    },
    account: {
      allowlisted_account_id: proposal.environment.allowlisted_account_id,
      resolved_caller_account_id: proposal.resolved_caller_account_id,
    },
    region: proposal.region,
    coordination: {
      coordination_resource_arn: proposal.environment.coordination_resource_arn,
      coordination_stack_identity: proposal.environment.coordination_stack_identity,
      expected_coordination_schema_version: EXPECTED_COORDINATION_SCHEMA_VERSION,
    },
    schema_digests: await readSchemaDigests(),
    selected_predecessor_probe_ids: [],
    environment_input_sha256: sha256Bytes(serializeCanonicalJson(environment)),
  };
}

async function readSchemaDigests(): Promise<
  Array<{ artifact_path: string; artifact_sha256: string }>
> {
  const names = (await readdir(SCHEMA_DIR))
    .filter((name) => name.endsWith(".json"))
    .toSorted();
  const digests: Array<{ artifact_path: string; artifact_sha256: string }> = [];
  for (const name of names) {
    const bytes = await readFile(join(SCHEMA_DIR, name));
    digests.push({
      artifact_path: `${SCHEMA_PATH_PREFIX}${name}`,
      artifact_sha256: sha256Bytes(bytes),
    });
  }
  return digests;
}

async function persistFrozenManifest(
  evidenceRoot: string,
  transportProbeId: string,
  bytes: string,
): Promise<string> {
  const probesDir = join(evidenceRoot, "transport-probes");
  const destDir = join(probesDir, transportProbeId);
  const destPath = join(destDir, MANIFEST_FILE_NAME);
  let stagingDir: string | undefined;

  if (await exists(destPath)) {
    throw new FrozenArtifactError(transportProbeId, destPath);
  }

  try {
    await mkdir(probesDir, { recursive: true });
    stagingDir = await mkdtemp(join(probesDir, `.${transportProbeId}.staging-`));
    const stagingPath = join(stagingDir, MANIFEST_FILE_NAME);
    await writeFile(stagingPath, bytes);
    await chmod(stagingPath, 0o444);
    await rename(stagingDir, destDir);
    stagingDir = undefined;
  } catch (error) {
    if (stagingDir !== undefined) {
      try {
        await rm(stagingDir, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "probe manifest persistence failed",
        );
      }
    }
    if (await exists(destPath)) {
      throw new FrozenArtifactError(transportProbeId, destPath);
    }
    throw error;
  }

  return destPath;
}

function recordHeaderReasons(
  record: Record<string, unknown>,
  expectedType: string,
): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  if (record.schema_version !== SCHEMA_VERSION) {
    reasons.push({
      code: "invalid_schema_version",
      category: "configuration",
      expected: SCHEMA_VERSION,
      observed: record.schema_version,
    });
  }
  if (typeof record.record_type !== "string") {
    reasons.push({
      code: "invalid_record_type",
      category: "configuration",
      expected: expectedType,
      observed: record.record_type,
    });
    return reasons;
  }
  if (!isCanonicalRecordType(record.record_type)) {
    reasons.push({
      code: "record_type_not_canonical",
      category: "configuration",
      expected: "lowercase snake_case record_type",
      observed: record.record_type,
    });
  }
  if (record.record_type !== expectedType) {
    reasons.push({
      code: "invalid_record_type",
      category: "configuration",
      expected: expectedType,
      observed: record.record_type,
    });
  }
  return reasons;
}

function uuidFieldReasons(
  record: Record<string, unknown>,
  field: string,
): RejectionReason[] {
  const value = record[field];
  if (typeof value === "string" && isLowercaseUuidV4(value)) {
    return [];
  }
  return [
    {
      code: "identifier_not_lowercase_uuid_v4",
      category: "configuration",
      expected: { field, format: "lowercase UUIDv4" },
      observed: value,
    },
  ];
}

function timestampFieldReasons(
  record: Record<string, unknown>,
  field: string,
): RejectionReason[] {
  const value = record[field];
  if (typeof value === "string" && isCanonicalUtcMillisecondTimestamp(value)) {
    return [];
  }
  return [
    {
      code: "timestamp_not_canonical_utc_millisecond",
      category: "configuration",
      expected: { field, format: "YYYY-MM-DDTHH:mm:ss.SSSZ" },
      observed: value,
    },
  ];
}

function tqDefinitionReasons(value: unknown): RejectionReason[] {
  if (!Array.isArray(value) || value.length !== EXPECTED_TQ_CONDITION_IDS.length) {
    return [
      {
        code: "tq_definitions_invalid",
        category: "configuration",
        expected: [...EXPECTED_TQ_CONDITION_IDS],
        observed: value,
      },
    ];
  }

  const reasons: RejectionReason[] = [];
  const seen: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry)) {
      reasons.push({
        code: "invalid_record_type",
        category: "configuration",
        expected: "transport_qualification_condition",
        observed: { index, entry },
      });
      continue;
    }
    reasons.push(
      ...recordHeaderReasons(entry, "transport_qualification_condition"),
    );
    if (typeof entry.condition_id !== "string") {
      reasons.push({
        code: "tq_condition_id_invalid",
        category: "configuration",
        expected: EXPECTED_TQ_CONDITION_IDS[index],
        observed: entry.condition_id,
      });
      continue;
    }
    seen.push(entry.condition_id);
    if (entry.condition_id !== EXPECTED_TQ_CONDITION_IDS[index]) {
      reasons.push({
        code: "tq_condition_id_invalid",
        category: "configuration",
        expected: EXPECTED_TQ_CONDITION_IDS[index],
        observed: entry.condition_id,
      });
    }
    const expectedDefinition = TQ_DEFINITIONS[index];
    if (expectedDefinition === undefined) {
      continue;
    }
    const expectedRefs = [...expectedDefinition.clock_assumption_refs];
    if (!isStringArrayEqual(entry.clock_assumption_refs, expectedRefs)) {
      reasons.push({
        code: "clock_assumption_refs_invalid",
        category: "configuration",
        expected: expectedRefs,
        observed: entry.clock_assumption_refs,
      });
    }
    reasons.push(...orderingBasisReasons(entry, expectedDefinition));
    if (entry.title !== expectedDefinition.title) {
      reasons.push({
        code: "tq_title_invalid",
        category: "configuration",
        expected: expectedDefinition.title,
        observed: entry.title,
      });
    }
    if (entry.statement !== expectedDefinition.statement) {
      reasons.push({
        code: "tq_statement_invalid",
        category: "configuration",
        expected: expectedDefinition.statement,
        observed: entry.statement,
      });
    }
  }

  if (seen.join(",") !== EXPECTED_TQ_CONDITION_IDS.join(",")) {
    reasons.push({
      code: "tq_definitions_invalid",
      category: "configuration",
      expected: [...EXPECTED_TQ_CONDITION_IDS],
      observed: seen,
    });
  }
  return reasons;
}

function orderingBasisReasons(
  entry: Record<string, unknown>,
  expectedDefinition: (typeof TQ_DEFINITIONS)[number],
): RejectionReason[] {
  if ("ordering_basis" in expectedDefinition) {
    if (entry.ordering_basis !== expectedDefinition.ordering_basis) {
      return [
        {
          code: "ordering_basis_invalid",
          category: "configuration",
          expected: expectedDefinition.ordering_basis,
          observed: entry.ordering_basis,
        },
      ];
    }
    return [];
  }
  if (Object.hasOwn(entry, "ordering_basis")) {
    return [
      {
        code: "ordering_basis_invalid",
        category: "configuration",
        expected: { omitted: true },
        observed: entry.ordering_basis,
      },
    ];
  }
  return [];
}

function schemaDigestReasons(value: unknown): RejectionReason[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [
      {
        code: "schema_digests_invalid",
        category: "configuration",
        expected: "nonempty schema digest array",
        observed: value,
      },
    ];
  }
  const reasons: RejectionReason[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry)) {
      reasons.push({
        code: "schema_digest_invalid",
        category: "configuration",
        expected: { artifact_path: "relative posix path", artifact_sha256: "hex" },
        observed: { index, entry },
      });
      continue;
    }
    if (
      typeof entry.artifact_path !== "string" ||
      !isNormalizedRelativePosixPath(entry.artifact_path)
    ) {
      reasons.push({
        code: "synthesis_path_invalid",
        category: "configuration",
        expected: "normalized relative POSIX path",
        observed: entry.artifact_path,
      });
    }
    if (
      typeof entry.artifact_sha256 !== "string" ||
      !SHA256_HEX_PATTERN.test(entry.artifact_sha256)
    ) {
      reasons.push({
        code: "digest_invalid",
        category: "configuration",
        expected: "lowercase SHA-256 hex",
        observed: entry.artifact_sha256,
      });
    }
  }
  return reasons;
}

function timingContractReasons(timing: Record<string, unknown>): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  if (timing.retry_jitter !== RETRY_JITTER) {
    reasons.push({
      code: "retry_jitter_invalid",
      category: "configuration",
      expected: RETRY_JITTER,
      observed: timing.retry_jitter,
    });
  }
  for (const [field, expected] of Object.entries(PROBE_TIMING)) {
    if (field === "retry_jitter") {
      continue;
    }
    if (timing[field] !== expected) {
      reasons.push({
        code: "timing_invalid",
        category: "configuration",
        expected: { ...PROBE_TIMING },
        observed: timing,
      });
      break;
    }
  }
  return reasons;
}

function requiredManifestBlockReasons(
  manifest: Record<string, unknown>,
): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  for (const field of ["safety", "source", "tools", "account", "coordination"] as const) {
    if (!isPlainObject(manifest[field])) {
      reasons.push({
        code: `${field}_invalid`,
        category: "configuration",
        expected: "object",
        observed: manifest[field],
      });
    }
  }
  if (isPlainObject(manifest.safety)) {
    reasons.push(...safetyContractReasons(manifest.safety));
  }
  if (isPlainObject(manifest.source)) {
    reasons.push(...sourceEvidenceReasons(manifest.source));
  }
  if (isPlainObject(manifest.tools)) {
    reasons.push(...toolsEvidenceReasons(manifest.tools));
  }
  if (isPlainObject(manifest.account)) {
    reasons.push(...accountEvidenceReasons(manifest.account));
  }
  if (manifest.region !== ALLOWED_REGION) {
    reasons.push({
      code: "region_not_allowed",
      category: "region",
      expected: ALLOWED_REGION,
      observed: manifest.region,
    });
  }
  if (isPlainObject(manifest.coordination)) {
    reasons.push(...coordinationEvidenceReasons(manifest.coordination, manifest.account));
  }
  return reasons;
}

function paymentEvidenceReasons(payment: Record<string, unknown>): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  if (!isPresentCanonicalString(payment.payment_id)) {
    reasons.push({
      code: "identifier_empty",
      category: "configuration",
      expected: "nonempty payment_id",
      observed: payment.payment_id,
    });
  }
  reasons.push(...amountEvidenceReasons("captured_amount_minor", payment.captured_amount_minor));
  if (payment.currency !== ALLOWED_CURRENCY) {
    reasons.push({
      code: "currency_not_brl",
      category: "configuration",
      expected: ALLOWED_CURRENCY,
      observed: payment.currency,
    });
  }
  return reasons;
}

function approvedDecisionEvidenceReasons(
  decision: Record<string, unknown>,
): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  if (!isPresentCanonicalString(decision.refund_request_id)) {
    reasons.push({
      code: "identifier_empty",
      category: "configuration",
      expected: "nonempty refund_request_id",
      observed: decision.refund_request_id,
    });
  }
  if (!isPresentCanonicalString(decision.payment_id)) {
    reasons.push({
      code: "identifier_empty",
      category: "configuration",
      expected: "nonempty payment_id",
      observed: decision.payment_id,
    });
  }
  if (decision.decision !== "APPROVED") {
    reasons.push({
      code: "decision_not_approved",
      category: "configuration",
      expected: "APPROVED",
      observed: decision.decision,
    });
  }
  reasons.push(
    ...amountEvidenceReasons("approved_amount_minor", decision.approved_amount_minor),
  );
  if (decision.currency !== ALLOWED_CURRENCY) {
    reasons.push({
      code: "currency_not_brl",
      category: "configuration",
      expected: ALLOWED_CURRENCY,
      observed: decision.currency,
    });
  }
  return reasons;
}

function linkedFinancialReasons(
  payment: Record<string, unknown>,
  decision: Record<string, unknown>,
): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  if (
    isPresentCanonicalString(payment.payment_id) &&
    isPresentCanonicalString(decision.payment_id) &&
    payment.payment_id !== decision.payment_id
  ) {
    reasons.push({
      code: "payment_id_mismatch",
      category: "configuration",
      expected: payment.payment_id,
      observed: decision.payment_id,
    });
  }
  if (
    Number.isSafeInteger(payment.captured_amount_minor) &&
    Number.isSafeInteger(decision.approved_amount_minor) &&
    payment.captured_amount_minor !== decision.approved_amount_minor
  ) {
    reasons.push({
      code: "amounts_not_equal",
      category: "configuration",
      expected: payment.captured_amount_minor,
      observed: decision.approved_amount_minor,
    });
  }
  return reasons;
}

function sourceEvidenceReasons(source: Record<string, unknown>): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  if (!isPresentCanonicalString(source.head_revision)) {
    reasons.push({
      code: "revision_missing",
      category: "source",
      expected: "resolvable committed HEAD",
      observed: source.head_revision,
    });
  }
  if (source.lockfile_present !== true) {
    reasons.push({
      code: "lockfile_missing",
      category: "source",
      expected: true,
      observed: source.lockfile_present,
    });
  }
  if (source.lockfile_tracked !== true) {
    reasons.push({
      code: "lockfile_missing",
      category: "source",
      expected: { lockfile_tracked: true },
      observed: source.lockfile_tracked,
    });
  }
  return reasons;
}

function toolsEvidenceReasons(tools: Record<string, unknown>): RejectionReason[] {
  if (isCompleteNode24Version(tools.node_version)) {
    return [];
  }
  return [
    {
      code: "node_version_unsupported",
      category: "tool",
      expected: "24.x.y or v24.x.y",
      observed: tools.node_version,
    },
  ];
}

function accountEvidenceReasons(account: Record<string, unknown>): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  const allowlisted = account.allowlisted_account_id;
  const caller = account.resolved_caller_account_id;
  if (typeof allowlisted !== "string" || !ACCOUNT_ID_PATTERN.test(allowlisted)) {
    reasons.push({
      code: "account_not_12_digit",
      category: "account",
      expected: "12-digit account id",
      observed: allowlisted,
    });
  }
  if (typeof caller !== "string" || !ACCOUNT_ID_PATTERN.test(caller)) {
    reasons.push({
      code: "account_not_12_digit",
      category: "account",
      expected: "12-digit account id",
      observed: caller,
    });
  }
  if (
    typeof allowlisted === "string" &&
    ACCOUNT_ID_PATTERN.test(allowlisted) &&
    typeof caller === "string" &&
    ACCOUNT_ID_PATTERN.test(caller) &&
    allowlisted !== caller
  ) {
    reasons.push({
      code: "account_not_allowlisted",
      category: "account",
      expected: allowlisted,
      observed: caller,
    });
  }
  return reasons;
}

function coordinationEvidenceReasons(
  coordination: Record<string, unknown>,
  account: unknown,
): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  const parsedArn = parseAwsArn(coordination.coordination_resource_arn);
  const allowlisted =
    isPlainObject(account) && typeof account.allowlisted_account_id === "string"
      ? account.allowlisted_account_id
      : undefined;
  if (parsedArn === undefined) {
    reasons.push({
      code: "coordination_arn_invalid",
      category: "coordination",
      expected: "arn:aws:<service>:<region>:<account>:<resource>",
      observed: coordination.coordination_resource_arn,
    });
  } else {
    if (parsedArn.region !== ALLOWED_REGION) {
      reasons.push({
        code: "coordination_region_mismatch",
        category: "coordination",
        expected: ALLOWED_REGION,
        observed: parsedArn.region,
      });
    }
    if (allowlisted !== undefined && parsedArn.accountId !== allowlisted) {
      reasons.push({
        code: "coordination_account_mismatch",
        category: "coordination",
        expected: allowlisted,
        observed: parsedArn.accountId,
      });
    }
  }
  if (!isPresentCanonicalString(coordination.coordination_stack_identity)) {
    reasons.push({
      code: "coordination_stack_identity_empty",
      category: "coordination",
      expected: "nonempty coordination stack identity",
      observed: coordination.coordination_stack_identity,
    });
  }
  if (
    coordination.expected_coordination_schema_version !==
    EXPECTED_COORDINATION_SCHEMA_VERSION
  ) {
    reasons.push({
      code: "coordination_schema_version_mismatch",
      category: "coordination",
      expected: EXPECTED_COORDINATION_SCHEMA_VERSION,
      observed: coordination.expected_coordination_schema_version,
    });
  }
  return reasons;
}

function safetyContractReasons(safety: Record<string, unknown>): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  if (safety.region !== ALLOWED_REGION) {
    reasons.push({
      code: "region_not_allowed",
      category: "region",
      expected: ALLOWED_REGION,
      observed: safety.region,
    });
  }
  const durations = {
    active_probe_time_seconds: PROBE_ACTIVE_TIME_SECONDS,
    reserved_cleanup_seconds: PROBE_RESERVED_CLEANUP_SECONDS,
    total_target_seconds: PROBE_TOTAL_TARGET_SECONDS,
    stabilization_interval_seconds: PROBE_STABILIZATION_INTERVAL_SECONDS,
  };
  for (const [field, expected] of Object.entries(durations)) {
    if (safety[field] !== expected) {
      reasons.push({
        code: "probe_duration_invalid",
        category: "configuration",
        expected: { field, value: expected },
        observed: safety[field],
      });
    }
  }
  const usage = safety.estimated_attributable_usage_usd_minor;
  if (!isNonNegativeSafeInteger(usage)) {
    reasons.push({
      code: "estimated_cost_invalid",
      category: "configuration",
      expected: { max_usd_minor: PROBE_USAGE_CEILING_USD_MINOR },
      observed: usage,
    });
  } else if (usage > PROBE_USAGE_CEILING_USD_MINOR) {
    reasons.push({
      code: "estimated_cost_exceeds_ceiling",
      category: "configuration",
      expected: { max_usd_minor: PROBE_USAGE_CEILING_USD_MINOR },
      observed: usage,
    });
  }
  if (!isPresentCanonicalString(safety.ownership_strategy)) {
    reasons.push({
      code: "ownership_strategy_missing",
      category: "configuration",
      expected: "nonempty ownership strategy",
      observed: safety.ownership_strategy,
    });
  }
  return reasons;
}

function isPresentCanonicalString(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value === value.trim();
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function amountEvidenceReasons(field: string, value: unknown): RejectionReason[] {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return [
      {
        code: "amount_not_positive_integer",
        category: "configuration",
        expected: { field, min: 1, integer: true },
        observed: value,
      },
    ];
  }
  if (value > MAX_SAFE_AMOUNT_MINOR) {
    return [
      {
        code: "amount_exceeds_safe_integer",
        category: "configuration",
        expected: { field, max: MAX_SAFE_AMOUNT_MINOR },
        observed: value,
      },
    ];
  }
  return [];
}

function isCompleteNode24Version(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = value.match(/^v?24\.\d+\.\d+/);
  return match !== null && match[0] === value;
}

function parseAwsArn(
  value: unknown,
): { region: string; accountId: string } | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parts = value.split(":");
  if (parts.length < 6 || parts[0] !== "arn" || parts[1] !== "aws") {
    return undefined;
  }
  const service = parts[2];
  const region = parts[3];
  const accountId = parts[4];
  const resource = parts.slice(5).join(":");
  if (
    service === undefined ||
    service === "" ||
    region === undefined ||
    region === "" ||
    accountId === undefined ||
    accountId === "" ||
    resource === ""
  ) {
    return undefined;
  }
  return { region, accountId };
}

function isStringArrayEqual(value: unknown, expected: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
