import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  admitProbeAttempt,
  ALLOWED_CURRENCY,
  ALLOWED_REGION,
  freezeProbeDefinition,
  FrozenArtifactError,
  isCanonicalUtcMillisecondTimestamp,
  ProbeManifestValidationError,
  PROBE_USAGE_CEILING_USD_MINOR,
  TerminalProbeIdentityError,
  serializeCanonicalJson,
  serializeProbeManifest,
  sha256Bytes,
} from "../src/probe-admission/index.ts";
import type {
  CloudMutationAdapter,
  CloudMutationRequest,
  ProbeAttemptProposal,
} from "../src/probe-admission/index.ts";

const FIXED_ATTEMPT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECOND_ATTEMPT_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const FIXED_NOW = new Date("2026-08-25T17:17:00.000Z");
const GOLDEN_MANIFEST_PATH = fileURLToPath(
  new URL("./golden/transport-probe-manifest.json", import.meta.url),
);
const SCHEMA_DIR = fileURLToPath(
  new URL("../src/probe-admission/schemas/", import.meta.url),
);

class RecordingCloudMutationAdapter implements CloudMutationAdapter {
  readonly calls: CloudMutationRequest[] = [];

  mutate(request: CloudMutationRequest): void {
    this.calls.push(request);
  }
}

function validProposal(): ProbeAttemptProposal {
  return {
    payment: {
      schema_version: 1,
      record_type: "payment",
      payment_id: "pay-poc-001",
      captured_amount_minor: 10000,
      currency: ALLOWED_CURRENCY,
    },
    approved_decision: {
      schema_version: 1,
      record_type: "approved_decision",
      refund_request_id: "ref-poc-001",
      payment_id: "pay-poc-001",
      decision: "APPROVED",
      approved_amount_minor: 10000,
      currency: ALLOWED_CURRENCY,
    },
    environment: {
      allowlisted_account_id: "123456789012",
      coordination_resource_arn:
        "arn:aws:dynamodb:us-east-1:123456789012:table/study-1-coordination",
      coordination_stack_identity: "study-1-coordination",
      expected_coordination_schema_version: 1,
    },
    resolved_caller_account_id: "123456789012",
    region: ALLOWED_REGION,
    source: {
      head_revision: "666de374f7ef9facda60702ea9f3ceaf209ccdc2",
      lockfile_present: true,
      lockfile_tracked: true,
    },
    tools: { node_version: "24.15.0" },
    synthesis: {
      files: [{ path: "assembly/template.json", kind: "regular" }],
    },
    safety: {
      active_probe_time_seconds: 600,
      reserved_cleanup_seconds: 600,
      total_target_seconds: 1200,
      stabilization_interval_seconds: 120,
      estimated_attributable_usage_usd_minor: 100,
      ownership_strategy: "resource_tags",
    },
  };
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function freeze(
  proposal: ProbeAttemptProposal,
  mutation = new RecordingCloudMutationAdapter(),
  createId: () => string = () => FIXED_ATTEMPT_ID,
) {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "probe-definition-"));
  const result = await freezeProbeDefinition(proposal, {
    evidenceRoot,
    mutation,
    now: () => FIXED_NOW,
    createId,
  });
  return { result, evidenceRoot, mutation };
}

async function validManifest(): Promise<Record<string, unknown>> {
  const { result } = await freeze(validProposal());
  assert.equal(result.status, "frozen");
  if (result.status !== "frozen") {
    throw new Error("expected frozen result");
  }
  return JSON.parse(await readFile(result.manifest_path, "utf8")) as Record<
    string,
    unknown
  >;
}

test("AC-8: freeze promotes the admitted UUID and writes protocol inputs before mutation", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const { result, evidenceRoot } = await freeze(validProposal(), mutation);

  assert.equal(result.status, "frozen");
  if (result.status !== "frozen") {
    throw new Error("expected frozen result");
  }
  assert.equal(result.transport_probe_id, FIXED_ATTEMPT_ID);
  assert.equal(result.probe_attempt_id, FIXED_ATTEMPT_ID);
  assert.deepEqual(mutation.calls, []);
  await assert.rejects(
    () => readdir(join(evidenceRoot, "probe-attempts")),
    isEnoent,
  );

  const stored = await readFile(result.manifest_path, "utf8");
  const manifest = JSON.parse(stored) as {
    schema_version: number;
    record_type: string;
    transport_probe_id: string;
    probe_attempt_id: string;
    frozen_at: string;
    payment: { payment_id: string; captured_amount_minor: number };
    approved_decision: { refund_request_id: string };
    timing: Record<string, unknown>;
    safety: Record<string, unknown>;
    clock_assumption: { assumption_id: string; status: string };
    clock_assumption_refs: string[];
    fidelity_basis: string;
    tq_definitions: Array<{
      condition_id: string;
      clock_assumption_refs: string[];
      ordering_basis?: unknown;
    }>;
    source: { head_revision: string };
    tools: { node_version: string };
    account: {
      allowlisted_account_id: string;
      resolved_caller_account_id: string;
    };
    region: string;
    coordination: { expected_coordination_schema_version: number };
    schema_digests: Array<{ artifact_path: string; artifact_sha256: string }>;
    selected_predecessor_probe_ids: unknown[];
    environment_input_sha256: string;
  };

  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.record_type, "transport_probe_manifest");
  assert.equal(manifest.transport_probe_id, FIXED_ATTEMPT_ID);
  assert.equal(manifest.probe_attempt_id, FIXED_ATTEMPT_ID);
  assert.equal(manifest.frozen_at, "2026-08-25T17:17:00.000Z");
  assert.equal(manifest.payment.payment_id, "pay-poc-001");
  assert.equal(manifest.payment.captured_amount_minor, 10000);
  assert.equal(manifest.approved_decision.refund_request_id, "ref-poc-001");
  assert.deepEqual(manifest.timing, {
    provider_client_deadline_seconds: 3,
    provider_safety_release_seconds: 15,
    provider_execution_timeout_seconds: 30,
    treatment_state_polling_interval_milliseconds: 250,
    retry_jitter: "NONE",
  });
  assert.deepEqual(manifest.safety, {
    region: ALLOWED_REGION,
    active_probe_time_seconds: 600,
    reserved_cleanup_seconds: 600,
    total_target_seconds: 1200,
    estimated_attributable_usage_usd_minor: 100,
    stabilization_interval_seconds: 120,
    ownership_strategy: "resource_tags",
  });
  assert.equal(manifest.clock_assumption.assumption_id, "CA-1");
  assert.equal(
    manifest.clock_assumption.status,
    "declared_not_service_guaranteed",
  );
  assert.deepEqual(manifest.clock_assumption_refs, ["CA-1"]);
  assert.equal(
    manifest.fidelity_basis,
    "causal_plus_cross_source_clock_assumption",
  );
  assert.deepEqual(
    manifest.tq_definitions.map((entry) => entry.condition_id),
    ["TQ-1", "TQ-2", "TQ-3", "TQ-4", "TQ-5", "TQ-6"],
  );
  assert.deepEqual(manifest.tq_definitions[0]?.clock_assumption_refs, ["CA-1"]);
  assert.equal(
    manifest.tq_definitions[0]?.ordering_basis,
    "cross_source_wall_clock",
  );
  assert.equal(manifest.source.head_revision, "666de374f7ef9facda60702ea9f3ceaf209ccdc2");
  assert.equal(manifest.tools.node_version, "24.15.0");
  assert.equal(manifest.account.allowlisted_account_id, "123456789012");
  assert.equal(manifest.account.resolved_caller_account_id, "123456789012");
  assert.equal(manifest.region, ALLOWED_REGION);
  assert.equal(manifest.coordination.expected_coordination_schema_version, 1);
  assert.equal(manifest.schema_digests.length > 0, true);
  assert.deepEqual(manifest.selected_predecessor_probe_ids, []);
  assert.match(manifest.environment_input_sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    stored.includes('"git_branch"'),
    false,
  );
  assert.equal(stored.includes('"selected_transport_probe_id"'), false);
});

test("AC-10: frozen manifest bytes and SHA-256 match the committed golden", async () => {
  const { result } = await freeze(validProposal());
  assert.equal(result.status, "frozen");
  if (result.status !== "frozen") {
    throw new Error("expected frozen result");
  }

  const stored = await readFile(result.manifest_path);
  const golden = await readFile(GOLDEN_MANIFEST_PATH);
  assert.deepEqual(stored, golden);
  assert.equal(result.manifest_sha256, sha256Bytes(golden));
  assert.equal(sha256Bytes(stored), sha256Bytes(golden));
  assert.equal(result.manifest_sha256, sha256Bytes(stored));
});

test("AC-10: key-order-equivalent objects serialize and hash identically", () => {
  const insertionA = {
    zeta: 1,
    alpha: { nested_b: true, nested_a: "x" },
  };
  const insertionB = {
    alpha: { nested_a: "x", nested_b: true },
    zeta: 1,
  };
  const bytesA = serializeCanonicalJson(insertionA);
  const bytesB = serializeCanonicalJson(insertionB);
  assert.equal(bytesA, bytesB);
  assert.equal(sha256Bytes(bytesA), sha256Bytes(bytesB));
});

test("AC-10: schema digests are lowercase SHA-256 of the exact schema-file bytes", async () => {
  const { result } = await freeze(validProposal());
  assert.equal(result.status, "frozen");
  if (result.status !== "frozen") {
    throw new Error("expected frozen result");
  }
  const manifest = JSON.parse(await readFile(result.manifest_path, "utf8")) as {
    schema_digests: Array<{ artifact_path: string; artifact_sha256: string }>;
  };
  const names = (await readdir(SCHEMA_DIR))
    .filter((name) => name.endsWith(".json"))
    .toSorted();
  const expected = [];
  for (const name of names) {
    const bytes = await readFile(join(SCHEMA_DIR, name));
    expected.push({
      artifact_path: `src/probe-admission/schemas/${name}`,
      artifact_sha256: sha256Bytes(bytes),
    });
  }
  assert.deepEqual(manifest.schema_digests, expected);
});

test("AC-10: required empty arrays serialize as [] and omitted optionals are not null", async () => {
  const { result } = await freeze(validProposal());
  assert.equal(result.status, "frozen");
  if (result.status !== "frozen") {
    throw new Error("expected frozen result");
  }
  const stored = await readFile(result.manifest_path, "utf8");
  const manifest = JSON.parse(stored) as {
    tq_definitions: Array<Record<string, unknown>>;
    selected_predecessor_probe_ids: unknown;
  };

  assert.deepEqual(manifest.selected_predecessor_probe_ids, []);
  assert.equal(stored.includes('"selected_predecessor_probe_ids": null'), false);
  assert.deepEqual(manifest.tq_definitions[1]?.clock_assumption_refs, []);
  assert.equal(
    Object.hasOwn(manifest.tq_definitions[1] ?? {}, "ordering_basis"),
    false,
  );
  assert.equal(JSON.stringify(manifest.tq_definitions[1]).includes('"ordering_basis"'), false);

  const omitted = serializeCanonicalJson({ a: 1 });
  const semanticNull = serializeCanonicalJson({ a: 1, b: null });
  const requiredEmpty = serializeCanonicalJson({ a: 1, b: [] });
  assert.equal(omitted.includes('"b"'), false);
  assert.equal(semanticNull.includes('"b": null'), true);
  assert.equal(requiredEmpty.includes('"b": []'), true);
  assert.notEqual(sha256Bytes(omitted), sha256Bytes(semanticNull));
  assert.notEqual(sha256Bytes(semanticNull), sha256Bytes(requiredEmpty));
  assert.notEqual(sha256Bytes(omitted), sha256Bytes(requiredEmpty));
});

test("AC-10: post-freeze writes are refused and stored bytes stay unchanged", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const first = await freeze(validProposal(), mutation);
  assert.equal(first.result.status, "frozen");
  if (first.result.status !== "frozen") {
    throw new Error("expected frozen result");
  }
  const frozenPath = first.result.manifest_path;
  const before = await readFile(frozenPath);

  await assert.rejects(
    () =>
      freezeProbeDefinition(validProposal(), {
        evidenceRoot: first.evidenceRoot,
        mutation,
        now: () => FIXED_NOW,
        createId: () => FIXED_ATTEMPT_ID,
      }),
    (error: unknown) => error instanceof FrozenArtifactError,
  );
  assert.deepEqual(await readFile(frozenPath), before);
  assert.deepEqual(mutation.calls, []);

  await assert.rejects(
    () => writeFile(frozenPath, "{}\n"),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES",
  );
  assert.deepEqual(await readFile(frozenPath), before);
});

test("AC-10: stale freeze staging does not block a unique persist", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const evidenceRoot = await mkdtemp(join(tmpdir(), "probe-definition-"));
  const stale = join(
    evidenceRoot,
    "transport-probes",
    `.${FIXED_ATTEMPT_ID}.staging`,
  );
  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, "residue.txt"), "old-staging\n");

  const result = await freezeProbeDefinition(validProposal(), {
    evidenceRoot,
    mutation,
    now: () => FIXED_NOW,
    createId: () => FIXED_ATTEMPT_ID,
  });
  assert.equal(result.status, "frozen");
  assert.deepEqual(await readdir(stale), ["residue.txt"]);
  const probes = await readdir(join(evidenceRoot, "transport-probes"));
  assert.equal(probes.includes(FIXED_ATTEMPT_ID), true);
  assert.equal(probes.includes(`.${FIXED_ATTEMPT_ID}.staging`), true);
  assert.equal(
    probes.some((name) => name.startsWith(`.${FIXED_ATTEMPT_ID}.staging-`)),
    false,
  );
  assert.deepEqual(mutation.calls, []);
});

test("AC-10: occupied destination without a manifest is not classified as frozen", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const evidenceRoot = await mkdtemp(join(tmpdir(), "probe-definition-"));
  const destDir = join(evidenceRoot, "transport-probes", FIXED_ATTEMPT_ID);
  await mkdir(destDir, { recursive: true });
  await writeFile(join(destDir, "other.txt"), "occupied\n");

  await assert.rejects(
    () =>
      freezeProbeDefinition(validProposal(), {
        evidenceRoot,
        mutation,
        now: () => FIXED_NOW,
        createId: () => FIXED_ATTEMPT_ID,
      }),
    (error: unknown) => {
      if (error instanceof FrozenArtifactError) {
        return false;
      }
      const code = (error as NodeJS.ErrnoException).code;
      return code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR";
    },
  );
  assert.deepEqual((await readdir(destDir)).toSorted(), ["other.txt"]);
  const probes = await readdir(join(evidenceRoot, "transport-probes"));
  assert.equal(
    probes.some((name) => name.includes("staging")),
    false,
  );
  assert.deepEqual(mutation.calls, []);
});

test("AC-10: concurrent same-identity freeze leaves one frozen winner", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const evidenceRoot = await mkdtemp(join(tmpdir(), "probe-definition-"));
  const deps = {
    evidenceRoot,
    mutation,
    now: () => FIXED_NOW,
    createId: () => FIXED_ATTEMPT_ID,
  };
  const outcomes = await Promise.allSettled([
    freezeProbeDefinition(validProposal(), deps),
    freezeProbeDefinition(validProposal(), deps),
  ]);
  const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  if (fulfilled[0]?.status !== "fulfilled") {
    throw new Error("expected a frozen winner");
  }
  assert.equal(fulfilled[0].value.status, "frozen");
  if (rejected[0]?.status !== "rejected") {
    throw new Error("expected a conflicting loser");
  }
  const error = rejected[0].reason;
  assert.equal(
    error instanceof FrozenArtifactError ||
      (error instanceof TerminalProbeIdentityError &&
        error.existing_outcome === "frozen"),
    true,
  );
  const probesDir = join(evidenceRoot, "transport-probes");
  const names = await readdir(probesDir);
  assert.deepEqual(
    names.filter((name) => !name.includes("staging")),
    [FIXED_ATTEMPT_ID],
  );
  await readFile(join(probesDir, FIXED_ATTEMPT_ID, "transport-probe-manifest.json"));
  assert.deepEqual(mutation.calls, []);
});

test("AC-8: a changed declared input requires a new identity and a new digest", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const original = await freeze(validProposal(), mutation);
  assert.equal(original.result.status, "frozen");
  if (original.result.status !== "frozen") {
    throw new Error("expected frozen result");
  }

  const changed = validProposal();
  changed.source.head_revision = "c03001c27fe6a2940051de9a3978225d00eb20f3";
  await assert.rejects(
    () =>
      freezeProbeDefinition(changed, {
        evidenceRoot: original.evidenceRoot,
        mutation,
        now: () => FIXED_NOW,
        createId: () => FIXED_ATTEMPT_ID,
      }),
    (error: unknown) => error instanceof FrozenArtifactError,
  );

  const next = await freeze(changed, mutation, () => SECOND_ATTEMPT_ID);
  assert.equal(next.result.status, "frozen");
  if (next.result.status !== "frozen") {
    throw new Error("expected frozen result");
  }
  assert.equal(next.result.transport_probe_id, SECOND_ATTEMPT_ID);
  assert.notEqual(next.result.manifest_sha256, original.result.manifest_sha256);
  const nextManifest = JSON.parse(
    await readFile(next.result.manifest_path, "utf8"),
  ) as { source: { head_revision: string }; transport_probe_id: string };
  assert.equal(
    nextManifest.source.head_revision,
    "c03001c27fe6a2940051de9a3978225d00eb20f3",
  );
  assert.equal(nextManifest.transport_probe_id, SECOND_ATTEMPT_ID);
  assert.deepEqual(mutation.calls, []);
});

test("AC-10: UUID, timestamp, and enumeration faults reject without canonical bytes", async () => {
  const base = await validManifest();
  const cases: Array<{ name: string; mutate: (manifest: Record<string, unknown>) => void; code: string }> =
    [
      {
        name: "uppercase UUID",
        mutate: (manifest) => {
          manifest.transport_probe_id = FIXED_ATTEMPT_ID.toUpperCase();
          manifest.probe_attempt_id = FIXED_ATTEMPT_ID.toUpperCase();
        },
        code: "identifier_not_lowercase_uuid_v4",
      },
      {
        name: "UUIDv1",
        mutate: (manifest) => {
          manifest.transport_probe_id = "aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee";
          manifest.probe_attempt_id = "aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee";
        },
        code: "identifier_not_lowercase_uuid_v4",
      },
      {
        name: "timestamp without milliseconds",
        mutate: (manifest) => {
          manifest.frozen_at = "2026-08-25T17:17:00Z";
        },
        code: "timestamp_not_canonical_utc_millisecond",
      },
      {
        name: "timestamp with extra precision",
        mutate: (manifest) => {
          manifest.frozen_at = "2026-08-25T17:17:00.000000Z";
        },
        code: "timestamp_not_canonical_utc_millisecond",
      },
      {
        name: "timestamp with offset",
        mutate: (manifest) => {
          manifest.frozen_at = "2026-08-25T17:17:00.000+00:00";
        },
        code: "timestamp_not_canonical_utc_millisecond",
      },
      {
        name: "invalid month matching timestamp shape",
        mutate: (manifest) => {
          manifest.frozen_at = "2026-13-01T00:00:00.000Z";
        },
        code: "timestamp_not_canonical_utc_millisecond",
      },
      {
        name: "invalid hour matching timestamp shape",
        mutate: (manifest) => {
          manifest.frozen_at = "2026-01-01T25:00:00.000Z";
        },
        code: "timestamp_not_canonical_utc_millisecond",
      },
      {
        name: "uppercase record_type",
        mutate: (manifest) => {
          manifest.record_type = "Transport_Probe_Manifest";
        },
        code: "record_type_not_canonical",
      },
      {
        name: "retry jitter enumeration",
        mutate: (manifest) => {
          const timing = manifest.timing as Record<string, unknown>;
          timing.retry_jitter = "none";
        },
        code: "retry_jitter_invalid",
      },
      {
        name: "provider-client deadline not the frozen PoC value",
        mutate: (manifest) => {
          const timing = manifest.timing as Record<string, unknown>;
          timing.provider_client_deadline_seconds = 4;
        },
        code: "timing_invalid",
      },
      {
        name: "fidelity basis enumeration",
        mutate: (manifest) => {
          manifest.fidelity_basis = "CAUSAL_PLUS_CROSS_SOURCE_CLOCK_ASSUMPTION";
        },
        code: "fidelity_basis_invalid",
      },
      {
        name: "TQ condition id enumeration",
        mutate: (manifest) => {
          const tq = manifest.tq_definitions as Array<Record<string, unknown>>;
          tq[0] = { ...tq[0], condition_id: "tq-1" };
        },
        code: "tq_condition_id_invalid",
      },
      {
        name: "TQ-1 clock_assumption_refs empty",
        mutate: (manifest) => {
          const tq = manifest.tq_definitions as Array<Record<string, unknown>>;
          tq[0] = { ...tq[0], clock_assumption_refs: [] };
        },
        code: "clock_assumption_refs_invalid",
      },
      {
        name: "TQ-2 clock_assumption_refs includes CA-1",
        mutate: (manifest) => {
          const tq = manifest.tq_definitions as Array<Record<string, unknown>>;
          tq[1] = { ...tq[1], clock_assumption_refs: ["CA-1"] };
        },
        code: "clock_assumption_refs_invalid",
      },
      {
        name: "TQ-1 ordering_basis changed",
        mutate: (manifest) => {
          const tq = manifest.tq_definitions as Array<Record<string, unknown>>;
          tq[0] = { ...tq[0], ordering_basis: "causal" };
        },
        code: "ordering_basis_invalid",
      },
      {
        name: "TQ-1 ordering_basis omitted",
        mutate: (manifest) => {
          const tq = manifest.tq_definitions as Array<Record<string, unknown>>;
          const next = { ...tq[0] };
          delete next.ordering_basis;
          tq[0] = next;
        },
        code: "ordering_basis_invalid",
      },
      {
        name: "TQ-2 ordering_basis added",
        mutate: (manifest) => {
          const tq = manifest.tq_definitions as Array<Record<string, unknown>>;
          tq[1] = { ...tq[1], ordering_basis: "cross_source_wall_clock" };
        },
        code: "ordering_basis_invalid",
      },
      {
        name: "TQ title altered",
        mutate: (manifest) => {
          const tq = manifest.tq_definitions as Array<Record<string, unknown>>;
          tq[0] = { ...tq[0], title: "Altered Title" };
        },
        code: "tq_title_invalid",
      },
      {
        name: "TQ statement altered",
        mutate: (manifest) => {
          const tq = manifest.tq_definitions as Array<Record<string, unknown>>;
          tq[0] = { ...tq[0], statement: "Altered statement." };
        },
        code: "tq_statement_invalid",
      },
      {
        name: "CA-1 statement altered",
        mutate: (manifest) => {
          const clock = manifest.clock_assumption as Record<string, unknown>;
          clock.statement = "Altered clock statement.";
        },
        code: "clock_assumption_statement_invalid",
      },
      {
        name: "missing safety block",
        mutate: (manifest) => {
          delete manifest.safety;
        },
        code: "safety_invalid",
      },
      {
        name: "malformed safety block",
        mutate: (manifest) => {
          manifest.safety = "not-an-object";
        },
        code: "safety_invalid",
      },
      {
        name: "missing source block",
        mutate: (manifest) => {
          delete manifest.source;
        },
        code: "source_invalid",
      },
      {
        name: "malformed tools block",
        mutate: (manifest) => {
          manifest.tools = [];
        },
        code: "tools_invalid",
      },
      {
        name: "missing account block",
        mutate: (manifest) => {
          delete manifest.account;
        },
        code: "account_invalid",
      },
      {
        name: "missing region",
        mutate: (manifest) => {
          delete manifest.region;
        },
        code: "region_not_allowed",
      },
      {
        name: "missing coordination block",
        mutate: (manifest) => {
          delete manifest.coordination;
        },
        code: "coordination_invalid",
      },
      {
        name: "malformed coordination block",
        mutate: (manifest) => {
          manifest.coordination = 1;
        },
        code: "coordination_invalid",
      },
      {
        name: "empty source object",
        mutate: (manifest) => {
          manifest.source = {};
        },
        code: "revision_missing",
      },
      {
        name: "source missing lockfile flags",
        mutate: (manifest) => {
          manifest.source = { head_revision: "666de374f7ef9facda60702ea9f3ceaf209ccdc2" };
        },
        code: "lockfile_missing",
      },
      {
        name: "empty tools object",
        mutate: (manifest) => {
          manifest.tools = {};
        },
        code: "node_version_unsupported",
      },
      {
        name: "empty account object",
        mutate: (manifest) => {
          manifest.account = {};
        },
        code: "account_not_12_digit",
      },
      {
        name: "header-only payment object",
        mutate: (manifest) => {
          manifest.payment = { schema_version: 1, record_type: "payment" };
        },
        code: "identifier_empty",
      },
      {
        name: "header-only approved_decision object",
        mutate: (manifest) => {
          manifest.approved_decision = {
            schema_version: 1,
            record_type: "approved_decision",
          };
        },
        code: "identifier_empty",
      },
      {
        name: "payment captured_amount_minor is zero",
        mutate: (manifest) => {
          const payment = manifest.payment as Record<string, unknown>;
          payment.captured_amount_minor = 0;
        },
        code: "amount_not_positive_integer",
      },
      {
        name: "payment captured_amount_minor is negative",
        mutate: (manifest) => {
          const payment = manifest.payment as Record<string, unknown>;
          payment.captured_amount_minor = -1;
        },
        code: "amount_not_positive_integer",
      },
      {
        name: "payment currency is not BRL",
        mutate: (manifest) => {
          const payment = manifest.payment as Record<string, unknown>;
          payment.currency = "USD";
        },
        code: "currency_not_brl",
      },
      {
        name: "approved_amount_minor is zero",
        mutate: (manifest) => {
          const decision = manifest.approved_decision as Record<string, unknown>;
          decision.approved_amount_minor = 0;
        },
        code: "amount_not_positive_integer",
      },
      {
        name: "approved_decision currency is not BRL",
        mutate: (manifest) => {
          const decision = manifest.approved_decision as Record<string, unknown>;
          decision.currency = "USD";
        },
        code: "currency_not_brl",
      },
      {
        name: "approved_decision is not APPROVED",
        mutate: (manifest) => {
          const decision = manifest.approved_decision as Record<string, unknown>;
          decision.decision = "DENIED";
        },
        code: "decision_not_approved",
      },
      {
        name: "safety usage is negative",
        mutate: (manifest) => {
          const safety = manifest.safety as Record<string, unknown>;
          safety.estimated_attributable_usage_usd_minor = -1;
        },
        code: "estimated_cost_invalid",
      },
      {
        name: "coordination ARN is not an AWS ARN",
        mutate: (manifest) => {
          const coordination = manifest.coordination as Record<string, unknown>;
          coordination.coordination_resource_arn = "not-an-arn";
        },
        code: "coordination_arn_invalid",
      },
      {
        name: "lockfile_present is false",
        mutate: (manifest) => {
          const source = manifest.source as Record<string, unknown>;
          source.lockfile_present = false;
        },
        code: "lockfile_missing",
      },
      {
        name: "lockfile_tracked is false",
        mutate: (manifest) => {
          const source = manifest.source as Record<string, unknown>;
          source.lockfile_tracked = false;
        },
        code: "lockfile_missing",
      },
      {
        name: "node_version is not complete Node 24",
        mutate: (manifest) => {
          const tools = manifest.tools as Record<string, unknown>;
          tools.node_version = "22.14.0";
        },
        code: "node_version_unsupported",
      },
      {
        name: "node_version is incomplete Node 24",
        mutate: (manifest) => {
          const tools = manifest.tools as Record<string, unknown>;
          tools.node_version = "24";
        },
        code: "node_version_unsupported",
      },
      {
        name: "allowlisted and resolved caller accounts differ",
        mutate: (manifest) => {
          const account = manifest.account as Record<string, unknown>;
          account.resolved_caller_account_id = "999999999999";
        },
        code: "account_not_allowlisted",
      },
      {
        name: "coordination ARN region is not allowlisted",
        mutate: (manifest) => {
          const coordination = manifest.coordination as Record<string, unknown>;
          coordination.coordination_resource_arn =
            "arn:aws:dynamodb:us-west-2:123456789012:table/study-1-coordination";
        },
        code: "coordination_region_mismatch",
      },
      {
        name: "coordination ARN account differs from allowlisted account",
        mutate: (manifest) => {
          const coordination = manifest.coordination as Record<string, unknown>;
          coordination.coordination_resource_arn =
            "arn:aws:dynamodb:us-east-1:999999999999:table/study-1-coordination";
        },
        code: "coordination_account_mismatch",
      },
      {
        name: "payment IDs differ",
        mutate: (manifest) => {
          const decision = manifest.approved_decision as Record<string, unknown>;
          decision.payment_id = "pay-other-001";
        },
        code: "payment_id_mismatch",
      },
      {
        name: "captured and approved amounts differ",
        mutate: (manifest) => {
          const decision = manifest.approved_decision as Record<string, unknown>;
          decision.approved_amount_minor = 9999;
        },
        code: "amounts_not_equal",
      },
    ];

  for (const testCase of cases) {
    const manifest = structuredClone(base);
    testCase.mutate(manifest);
    let hashed: { bytes: string; sha256: string } | undefined;
    try {
      hashed = serializeProbeManifest(manifest);
      assert.fail(`expected rejection for ${testCase.name}`);
    } catch (error) {
      assert.equal(hashed, undefined, `${testCase.name} must not produce a digest`);
      assert.equal(error instanceof ProbeManifestValidationError, true, testCase.name);
      if (!(error instanceof ProbeManifestValidationError)) {
        throw error;
      }
      assert.equal(
        error.reasons.some((reason) => reason.code === testCase.code),
        true,
        `${testCase.name}: ${error.reasons.map((reason) => reason.code).join(",")}`,
      );
    }
  }
});

test("AC-10: usage at the ceiling serializes and usage above it does not", async () => {
  const atCeiling = await validManifest();
  const safetyAtCeiling = atCeiling.safety as Record<string, unknown>;
  safetyAtCeiling.estimated_attributable_usage_usd_minor = PROBE_USAGE_CEILING_USD_MINOR;
  const hashed = serializeProbeManifest(atCeiling);
  assert.match(hashed.sha256, /^[0-9a-f]{64}$/);

  const aboveCeiling = structuredClone(atCeiling);
  const safetyAbove = aboveCeiling.safety as Record<string, unknown>;
  safetyAbove.estimated_attributable_usage_usd_minor = PROBE_USAGE_CEILING_USD_MINOR + 1;
  let hashedAbove: { bytes: string; sha256: string } | undefined;
  try {
    hashedAbove = serializeProbeManifest(aboveCeiling);
    assert.fail("expected rejection for usage above the ceiling");
  } catch (error) {
    assert.equal(hashedAbove, undefined);
    assert.equal(error instanceof ProbeManifestValidationError, true);
    if (!(error instanceof ProbeManifestValidationError)) {
      throw error;
    }
    assert.equal(
      error.reasons.some((reason) => reason.code === "estimated_cost_exceeds_ceiling"),
      true,
    );
  }
});

test("AC-10: variable evidence still serializes when required frozen blocks are intact", async () => {
  const manifest = await validManifest();
  const payment = manifest.payment as Record<string, unknown>;
  const decision = manifest.approved_decision as Record<string, unknown>;
  payment.payment_id = "pay-other-001";
  decision.payment_id = "pay-other-001";
  payment.captured_amount_minor = 5000;
  decision.approved_amount_minor = 5000;
  const hashed = serializeProbeManifest(manifest);
  assert.match(hashed.sha256, /^[0-9a-f]{64}$/);
  assert.equal(hashed.bytes.includes('"pay-other-001"'), true);
  assert.equal(hashed.bytes.includes("5000"), true);
});

test("AC-8: a rejected attempt identity cannot later freeze a canonical probe", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const invalid = validProposal();
  invalid.region = "us-west-2";
  const rejected = await freeze(invalid, mutation);
  assert.equal(rejected.result.status, "rejected");

  await assert.rejects(
    () =>
      freezeProbeDefinition(validProposal(), {
        evidenceRoot: rejected.evidenceRoot,
        mutation,
        now: () => FIXED_NOW,
        createId: () => FIXED_ATTEMPT_ID,
      }),
    (error: unknown) =>
      error instanceof TerminalProbeIdentityError &&
      error.existing_outcome === "rejected" &&
      error.probe_attempt_id === FIXED_ATTEMPT_ID,
  );
  await assert.rejects(
    () => readdir(join(rejected.evidenceRoot, "transport-probes")),
    isEnoent,
  );
  assert.deepEqual(
    (await readdir(join(rejected.evidenceRoot, "probe-attempts", FIXED_ATTEMPT_ID))).toSorted(),
    ["preflight-journal.jsonl", "probe-rejection.json"],
  );
  assert.deepEqual(mutation.calls, []);
});

test("AC-8: a frozen identity cannot later write a rejected probe-attempt", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const frozen = await freeze(validProposal(), mutation);
  assert.equal(frozen.result.status, "frozen");
  const invalid = validProposal();
  invalid.region = "us-west-2";

  await assert.rejects(
    () =>
      admitProbeAttempt(invalid, {
        evidenceRoot: frozen.evidenceRoot,
        mutation,
        now: () => FIXED_NOW,
        createId: () => FIXED_ATTEMPT_ID,
      }),
    (error: unknown) =>
      error instanceof TerminalProbeIdentityError &&
      error.existing_outcome === "frozen" &&
      error.probe_attempt_id === FIXED_ATTEMPT_ID,
  );
  await assert.rejects(
    () => readdir(join(frozen.evidenceRoot, "probe-attempts")),
    isEnoent,
  );
  assert.deepEqual(mutation.calls, []);
});

test("AC-8: a frozen identity cannot later admit a valid proposal", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const frozen = await freeze(validProposal(), mutation);
  assert.equal(frozen.result.status, "frozen");
  if (frozen.result.status !== "frozen") {
    throw new Error("expected frozen result");
  }
  const before = await readFile(frozen.result.manifest_path);

  await assert.rejects(
    () =>
      admitProbeAttempt(validProposal(), {
        evidenceRoot: frozen.evidenceRoot,
        mutation,
        now: () => FIXED_NOW,
        createId: () => FIXED_ATTEMPT_ID,
      }),
    (error: unknown) =>
      error instanceof TerminalProbeIdentityError &&
      error.existing_outcome === "frozen" &&
      error.probe_attempt_id === FIXED_ATTEMPT_ID,
  );
  await assert.rejects(
    () => readdir(join(frozen.evidenceRoot, "probe-attempts")),
    isEnoent,
  );
  assert.deepEqual(await readFile(frozen.result.manifest_path), before);
  assert.deepEqual(mutation.calls, []);
});

test("AC-8: a rejected identity cannot later be reused via admitProbeAttempt", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const evidenceRoot = await mkdtemp(join(tmpdir(), "probe-definition-"));
  const invalid = validProposal();
  invalid.region = "us-west-2";
  const rejected = await admitProbeAttempt(invalid, {
    evidenceRoot,
    mutation,
    now: () => FIXED_NOW,
    createId: () => FIXED_ATTEMPT_ID,
  });
  assert.equal(rejected.status, "rejected");
  if (rejected.status !== "rejected") {
    throw new Error("expected rejected result");
  }
  const rejectionBefore = await readFile(rejected.rejection_path);
  const journalBefore = await readFile(rejected.journal_path);

  await assert.rejects(
    () =>
      admitProbeAttempt(validProposal(), {
        evidenceRoot,
        mutation,
        now: () => FIXED_NOW,
        createId: () => FIXED_ATTEMPT_ID,
      }),
    (error: unknown) =>
      error instanceof TerminalProbeIdentityError &&
      error.existing_outcome === "rejected" &&
      error.probe_attempt_id === FIXED_ATTEMPT_ID,
  );
  assert.deepEqual(await readFile(rejected.rejection_path), rejectionBefore);
  assert.deepEqual(await readFile(rejected.journal_path), journalBefore);
  await assert.rejects(() => readdir(join(evidenceRoot, "transport-probes")), isEnoent);
  assert.deepEqual(mutation.calls, []);
});

test("AC-10: regex-shaped invalid dates return false instead of throwing", () => {
  for (const value of [
    "2026-13-01T00:00:00.000Z",
    "2026-00-01T00:00:00.000Z",
    "2026-01-32T00:00:00.000Z",
    "2026-01-01T25:00:00.000Z",
    "2026-01-01T00:60:00.000Z",
    "2026-01-01T00:00:61.000Z",
  ]) {
    assert.equal(isCanonicalUtcMillisecondTimestamp(value), false, value);
  }
  assert.equal(
    isCanonicalUtcMillisecondTimestamp("2026-08-25T17:17:00.000Z"),
    true,
  );
});

test("AC-8: freeze reuses admission rejection and does not create a canonical probe", async () => {
  const proposal = validProposal();
  proposal.region = "us-west-2";
  const { result, evidenceRoot, mutation } = await freeze(proposal);

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") {
    throw new Error("expected rejected result");
  }
  await assert.rejects(
    () => readdir(join(evidenceRoot, "transport-probes")),
    isEnoent,
  );
  assert.deepEqual(
    (await readdir(join(evidenceRoot, "probe-attempts", FIXED_ATTEMPT_ID))).toSorted(),
    ["preflight-journal.jsonl", "probe-rejection.json"],
  );
  assert.deepEqual(mutation.calls, []);
});

test("AC-8: padded linked identifiers reject freeze without a canonical probe", async () => {
  const proposal = validProposal();
  proposal.payment.payment_id = "pay-poc-001";
  proposal.approved_decision.payment_id = "pay-poc-001 ";
  const { result, evidenceRoot, mutation } = await freeze(proposal);

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") {
    throw new Error("expected rejected result");
  }
  assert.equal(
    result.reasons.some((reason) => reason.code === "identifier_empty"),
    true,
  );
  await assert.rejects(
    () => readdir(join(evidenceRoot, "transport-probes")),
    isEnoent,
  );
  assert.deepEqual(
    (await readdir(join(evidenceRoot, "probe-attempts", FIXED_ATTEMPT_ID))).toSorted(),
    ["preflight-journal.jsonl", "probe-rejection.json"],
  );
  assert.deepEqual(mutation.calls, []);
});

test("AC-10: invalid injected UUID rejects freeze before any canonical write", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const evidenceRoot = await mkdtemp(join(tmpdir(), "probe-definition-"));

  await assert.rejects(
    () =>
      freezeProbeDefinition(validProposal(), {
        evidenceRoot,
        mutation,
        now: () => FIXED_NOW,
        createId: () => "not-a-uuid",
      }),
    /lowercase UUIDv4/,
  );
  await assert.rejects(
    () => readdir(join(evidenceRoot, "transport-probes")),
    isEnoent,
  );
  await assert.rejects(
    () => readdir(join(evidenceRoot, "probe-attempts")),
    isEnoent,
  );
  assert.deepEqual(mutation.calls, []);
});

test("AC-8: admit-only still writes no canonical freeze artifacts", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const evidenceRoot = await mkdtemp(join(tmpdir(), "probe-definition-"));
  const admitted = await admitProbeAttempt(validProposal(), {
    evidenceRoot,
    mutation,
    now: () => FIXED_NOW,
    createId: () => FIXED_ATTEMPT_ID,
  });
  assert.equal(admitted.status, "admitted");
  await assert.rejects(
    () => readdir(join(evidenceRoot, "transport-probes")),
    isEnoent,
  );
  await assert.rejects(
    () => readdir(join(evidenceRoot, "probe-attempts")),
    isEnoent,
  );
  assert.deepEqual(mutation.calls, []);
});
