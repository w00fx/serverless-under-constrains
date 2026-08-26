import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { formatUtcTimestamp, isLowercaseUuidV4 } from "./identity.ts";
import type {
  ProbeAdmissionDependencies,
  ProbeAdmissionResult,
  ProbeAttemptProposal,
  RejectionReason,
  SafetyInput,
  SynthesisInput,
} from "./types.ts";
import {
  ALLOWED_CURRENCY,
  ALLOWED_REGION,
  EXPECTED_COORDINATION_SCHEMA_VERSION,
  MAX_SAFE_AMOUNT_MINOR,
  PROBE_ACTIVE_TIME_SECONDS,
  PROBE_RESERVED_CLEANUP_SECONDS,
  PROBE_STABILIZATION_INTERVAL_SECONDS,
  PROBE_TOTAL_TARGET_SECONDS,
  PROBE_USAGE_CEILING_USD_MINOR,
  SCHEMA_VERSION,
} from "./types.ts";

const CREDENTIAL_KEY_PATTERN =
  /(credential|token|password|secret|access_key|credential_process)/i;

const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/;

export async function admitProbeAttempt(
  proposal: ProbeAttemptProposal,
  deps: ProbeAdmissionDependencies,
): Promise<ProbeAdmissionResult> {
  const probeAttemptId = resolveProbeAttemptId(deps.createId);
  const occurredAt = formatUtcTimestamp((deps.now ?? (() => new Date()))());
  const reasons = collectReasons(proposal);
  const serializedReasons = reasons.map(serializeReason);

  if (serializedReasons.length === 0) {
    return { status: "admitted", probe_attempt_id: probeAttemptId };
  }

  const probeAttemptsDir = join(deps.evidenceRoot, "probe-attempts");
  const attemptDir = join(probeAttemptsDir, probeAttemptId);
  const rejectionPath = join(attemptDir, "probe-rejection.json");
  const journalPath = join(attemptDir, "preflight-journal.jsonl");

  const rejection = {
    schema_version: SCHEMA_VERSION,
    record_type: "probe_rejection",
    probe_attempt_id: probeAttemptId,
    rejected_at: occurredAt,
    reasons: serializedReasons,
  };

  await persistRejectedAttempt(
    probeAttemptsDir,
    probeAttemptId,
    `${JSON.stringify(rejection, null, 2)}\n`,
    renderPreflightJournal(probeAttemptId, occurredAt, reasons),
  );

  return {
    status: "rejected",
    probe_attempt_id: probeAttemptId,
    rejection_path: rejectionPath,
    journal_path: journalPath,
    reasons: serializedReasons,
  };
}

async function persistRejectedAttempt(
  probeAttemptsDir: string,
  probeAttemptId: string,
  rejectionContents: string,
  journalContents: string,
): Promise<void> {
  const stagingDir = join(probeAttemptsDir, `.${probeAttemptId}.staging`);
  const attemptDir = join(probeAttemptsDir, probeAttemptId);
  try {
    await mkdir(probeAttemptsDir, { recursive: true });
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir);
    await writeFile(join(stagingDir, "probe-rejection.json"), rejectionContents);
    await writeFile(join(stagingDir, "preflight-journal.jsonl"), journalContents);
    await rename(stagingDir, attemptDir);
  } catch (error) {
    try {
      await rm(stagingDir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "probe rejection persistence failed",
      );
    }
    throw error;
  }
}

function resolveProbeAttemptId(createId: (() => string) | undefined): string {
  const id = createId?.() ?? randomUUID();
  if (!isLowercaseUuidV4(id)) {
    throw new Error("probe attempt identity must be a lowercase UUIDv4");
  }
  return id;
}

function collectReasons(proposal: ProbeAttemptProposal): RejectionReason[] {
  return [
    ...financialReasons(proposal),
    ...identityReasons(proposal),
    ...environmentReasons(proposal),
    ...accountReasons(proposal),
    ...regionReasons(proposal),
    ...sourceReasons(proposal),
    ...toolReasons(proposal),
    ...coordinationReasons(proposal),
    ...synthesisReasons(proposal.synthesis),
    ...safetyReasons(proposal.safety),
  ];
}

function financialReasons(proposal: ProbeAttemptProposal): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  const payment = proposal.payment;
  const decision = proposal.approved_decision;

  if (payment.schema_version !== SCHEMA_VERSION) {
    reasons.push({
      code: "invalid_schema_version",
      category: "configuration",
      expected: SCHEMA_VERSION,
      observed: payment.schema_version,
    });
  }
  if (payment.record_type !== "payment") {
    reasons.push({
      code: "invalid_record_type",
      category: "configuration",
      expected: "payment",
      observed: payment.record_type,
    });
  }
  if (decision.schema_version !== SCHEMA_VERSION) {
    reasons.push({
      code: "invalid_schema_version",
      category: "configuration",
      expected: SCHEMA_VERSION,
      observed: decision.schema_version,
    });
  }
  if (decision.record_type !== "approved_decision") {
    reasons.push({
      code: "invalid_record_type",
      category: "configuration",
      expected: "approved_decision",
      observed: decision.record_type,
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
    ...amountReasons("captured_amount_minor", payment.captured_amount_minor),
    ...amountReasons("approved_amount_minor", decision.approved_amount_minor),
  );

  if (payment.currency !== ALLOWED_CURRENCY) {
    reasons.push({
      code: "currency_not_brl",
      category: "configuration",
      expected: ALLOWED_CURRENCY,
      observed: payment.currency,
    });
  }
  if (decision.currency !== ALLOWED_CURRENCY) {
    reasons.push({
      code: "currency_not_brl",
      category: "configuration",
      expected: ALLOWED_CURRENCY,
      observed: decision.currency,
    });
  }
  if (
    payment.currency !== decision.currency &&
    typeof payment.currency === "string" &&
    typeof decision.currency === "string"
  ) {
    reasons.push({
      code: "currency_mismatch",
      category: "configuration",
      expected: payment.currency,
      observed: decision.currency,
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

function amountReasons(field: string, value: unknown): RejectionReason[] {
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

function identityReasons(proposal: ProbeAttemptProposal): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  const paymentId = nonemptyIdentifier(proposal.payment.payment_id);
  const decisionPaymentId = nonemptyIdentifier(proposal.approved_decision.payment_id);
  const refundRequestId = nonemptyIdentifier(
    proposal.approved_decision.refund_request_id,
  );

  if (paymentId === undefined) {
    reasons.push({
      code: "identifier_empty",
      category: "configuration",
      expected: "nonempty payment_id",
      observed: proposal.payment.payment_id,
    });
  }
  if (decisionPaymentId === undefined) {
    reasons.push({
      code: "identifier_empty",
      category: "configuration",
      expected: "nonempty payment_id",
      observed: proposal.approved_decision.payment_id,
    });
  }
  if (refundRequestId === undefined) {
    reasons.push({
      code: "identifier_empty",
      category: "configuration",
      expected: "nonempty refund_request_id",
      observed: proposal.approved_decision.refund_request_id,
    });
  }
  if (
    paymentId !== undefined &&
    decisionPaymentId !== undefined &&
    paymentId !== decisionPaymentId
  ) {
    reasons.push({
      code: "payment_id_mismatch",
      category: "configuration",
      expected: paymentId,
      observed: decisionPaymentId,
    });
  }
  return reasons;
}

function environmentReasons(proposal: ProbeAttemptProposal): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  const credentialKeys = forbiddenCredentialKeys(proposal.environment);
  if (credentialKeys.length > 0) {
    reasons.push({
      code: "credentials_in_environment",
      category: "configuration",
      expected: [],
      observed: credentialKeys,
    });
  }
  return reasons;
}

function accountReasons(proposal: ProbeAttemptProposal): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  const allowlisted = proposal.environment.allowlisted_account_id;
  const caller = proposal.resolved_caller_account_id;

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

function regionReasons(proposal: ProbeAttemptProposal): RejectionReason[] {
  if (proposal.region === ALLOWED_REGION) {
    return [];
  }
  return [
    {
      code: "region_not_allowed",
      category: "region",
      expected: ALLOWED_REGION,
      observed: proposal.region,
    },
  ];
}

function sourceReasons(proposal: ProbeAttemptProposal): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  const revision = nonemptyIdentifier(proposal.source.head_revision);
  if (revision === undefined) {
    reasons.push({
      code: "revision_missing",
      category: "source",
      expected: "resolvable committed HEAD",
      observed: proposal.source.head_revision,
    });
  }
  if (proposal.source.lockfile_present !== true) {
    reasons.push({
      code: "lockfile_missing",
      category: "source",
      expected: true,
      observed: proposal.source.lockfile_present,
    });
  }
  if (proposal.source.lockfile_tracked !== true) {
    reasons.push({
      code: "lockfile_missing",
      category: "source",
      expected: { lockfile_tracked: true },
      observed: proposal.source.lockfile_tracked,
    });
  }
  return reasons;
}

function toolReasons(proposal: ProbeAttemptProposal): RejectionReason[] {
  const version = proposal.tools.node_version;
  if (isCompleteNode24Version(version)) {
    return [];
  }
  return [
    {
      code: "node_version_unsupported",
      category: "tool",
      expected: "24.x.y or v24.x.y",
      observed: version,
    },
  ];
}

function isCompleteNode24Version(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = value.match(/^v?24\.\d+\.\d+/);
  return match !== null && match[0] === value;
}

function coordinationReasons(proposal: ProbeAttemptProposal): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  const environment = proposal.environment;
  const arn = environment.coordination_resource_arn;
  const stack = nonemptyIdentifier(environment.coordination_stack_identity);
  const schemaVersion = environment.expected_coordination_schema_version;
  const parsedArn = typeof arn === "string" ? parseArn(arn) : undefined;
  const account =
    typeof environment.allowlisted_account_id === "string"
      ? environment.allowlisted_account_id
      : undefined;

  if (parsedArn === undefined) {
    reasons.push({
      code: "coordination_arn_invalid",
      category: "coordination",
      expected: "arn:aws:<service>:<region>:<account>:<resource>",
      observed: arn,
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
    if (account !== undefined && parsedArn.accountId !== account) {
      reasons.push({
        code: "coordination_account_mismatch",
        category: "coordination",
        expected: account,
        observed: parsedArn.accountId,
      });
    }
  }

  if (stack === undefined) {
    reasons.push({
      code: "coordination_stack_identity_empty",
      category: "coordination",
      expected: "nonempty coordination stack identity",
      observed: environment.coordination_stack_identity,
    });
  }

  if (schemaVersion !== EXPECTED_COORDINATION_SCHEMA_VERSION) {
    reasons.push({
      code: "coordination_schema_version_mismatch",
      category: "coordination",
      expected: EXPECTED_COORDINATION_SCHEMA_VERSION,
      observed: schemaVersion,
    });
  }

  return reasons;
}

function synthesisReasons(
  synthesis: SynthesisInput | undefined | null,
): RejectionReason[] {
  if (synthesis === undefined || synthesis === null) {
    return [
      {
        code: "synthesis_input_missing",
        category: "synthesis",
        expected: "synthesis input object",
        observed: synthesis,
      },
    ];
  }

  const reasons: RejectionReason[] = [];
  const credentialKeys = forbiddenCredentialKeys(synthesis);
  if (credentialKeys.length > 0) {
    reasons.push({
      code: "credentials_in_synthesis",
      category: "synthesis",
      expected: [],
      observed: credentialKeys,
    });
  }

  if (!Array.isArray(synthesis.files)) {
    reasons.push({
      code: "synthesis_files_invalid",
      category: "synthesis",
      expected: "array",
      observed: synthesis.files,
    });
    return reasons;
  }

  for (const [index, file] of synthesis.files.entries()) {
    if (!isPlainObject(file)) {
      reasons.push({
        code: "synthesis_file_invalid",
        category: "synthesis",
        expected: { path: "relative posix path", kind: "regular" },
        observed: { index, file },
      });
      continue;
    }
    const path = file.path;
    if (!isNormalizedRelativePosixPath(path)) {
      reasons.push({
        code: "synthesis_path_invalid",
        category: "synthesis",
        expected: "normalized relative POSIX path",
        observed: path,
      });
    }
    if (file.kind !== "regular") {
      reasons.push({
        code: "synthesis_file_kind_rejected",
        category: "synthesis",
        expected: "regular",
        observed: file.kind,
      });
    }
  }

  return reasons;
}

function safetyReasons(safety: SafetyInput): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  const ownership = nonemptyIdentifier(safety.ownership_strategy);
  if (ownership === undefined) {
    reasons.push({
      code: "ownership_strategy_missing",
      category: "configuration",
      expected: "nonempty ownership strategy",
      observed: safety.ownership_strategy,
    });
  }

  reasons.push(
    ...declaredDurationReasons(
      "active_probe_time_seconds",
      safety.active_probe_time_seconds,
      PROBE_ACTIVE_TIME_SECONDS,
    ),
    ...declaredDurationReasons(
      "reserved_cleanup_seconds",
      safety.reserved_cleanup_seconds,
      PROBE_RESERVED_CLEANUP_SECONDS,
    ),
    ...declaredDurationReasons(
      "total_target_seconds",
      safety.total_target_seconds,
      PROBE_TOTAL_TARGET_SECONDS,
    ),
    ...declaredDurationReasons(
      "stabilization_interval_seconds",
      safety.stabilization_interval_seconds,
      PROBE_STABILIZATION_INTERVAL_SECONDS,
    ),
  );

  const usage = asNonNegativeSafeInteger(
    safety.estimated_attributable_usage_usd_minor,
  );

  if (usage === undefined) {
    reasons.push({
      code: "estimated_cost_invalid",
      category: "configuration",
      expected: { max_usd_minor: PROBE_USAGE_CEILING_USD_MINOR },
      observed: safety.estimated_attributable_usage_usd_minor,
    });
  } else if (usage > PROBE_USAGE_CEILING_USD_MINOR) {
    reasons.push({
      code: "estimated_cost_exceeds_ceiling",
      category: "configuration",
      expected: { max_usd_minor: PROBE_USAGE_CEILING_USD_MINOR },
      observed: usage,
    });
  }

  return reasons;
}

function declaredDurationReasons(
  field: string,
  value: unknown,
  expected: number,
): RejectionReason[] {
  if (value === expected) {
    return [];
  }
  return [
    {
      code: "probe_duration_invalid",
      category: "configuration",
      expected: { field, value: expected },
      observed: value,
    },
  ];
}

function isNormalizedRelativePosixPath(value: unknown): value is string {
  if (typeof value !== "string" || value === "") {
    return false;
  }
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonemptyIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function asNonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function forbiddenCredentialKeys(
  value: unknown,
  seen = new WeakSet<object>(),
): string[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return uniqueSorted(value.flatMap((item) => forbiddenCredentialKeys(item, seen)));
  }
  const keys: string[] = [];
  for (const key of Object.keys(value)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      keys.push(key);
    }
    keys.push(
      ...forbiddenCredentialKeys((value as Record<string, unknown>)[key], seen),
    );
  }
  return uniqueSorted(keys);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].toSorted();
}

function parseArn(
  arn: string,
): { region: string; accountId: string } | undefined {
  const parts = arn.split(":");
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

function serializeReason(reason: RejectionReason): RejectionReason {
  const serialized: RejectionReason = {
    code: reason.code,
    category: reason.category,
  };
  if (Object.hasOwn(reason, "expected")) {
    serialized.expected = jsonSafeValue(reason.expected);
  }
  if (Object.hasOwn(reason, "observed")) {
    serialized.observed = jsonSafeValue(reason.observed);
  }
  return serialized;
}

function jsonSafeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined) {
    return "[Undefined]";
  }
  if (typeof value === "function") {
    return "[Function]";
  }
  if (typeof value === "symbol") {
    return "[Symbol]";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number") {
    if (Object.is(value, -0)) {
      return 0;
    }
    if (!Number.isFinite(value)) {
      return String(value);
    }
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return Array.from(value, (item) => jsonSafeValue(item, seen));
      }
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        result[key] = jsonSafeValue(item, seen);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }
  return value;
}

function renderPreflightJournal(
  probeAttemptId: string,
  occurredAt: string,
  reasons: RejectionReason[],
): string {
  const categories = [
    "configuration",
    "source",
    "tool",
    "account",
    "region",
    "coordination",
    "synthesis",
  ] as const;

  const lines = categories.map((category) => {
    const categoryReasons = reasons.filter((reason) => reason.category === category);
    return JSON.stringify({
      schema_version: SCHEMA_VERSION,
      record_type: "preflight_check",
      probe_attempt_id: probeAttemptId,
      occurred_at: occurredAt,
      check: category,
      result: categoryReasons.length === 0 ? "passed" : "rejected",
      reason_codes: categoryReasons.map((reason) => reason.code),
    });
  });

  return `${lines.join("\n")}\n`;
}
