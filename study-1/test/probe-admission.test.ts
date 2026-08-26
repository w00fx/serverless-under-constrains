import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  admitProbeAttempt,
  ALLOWED_CURRENCY,
  ALLOWED_REGION,
  isLowercaseUuidV4,
  MAX_SAFE_AMOUNT_MINOR,
  PROBE_USAGE_CEILING_USD_MINOR,
} from "../src/probe-admission/index.ts";
import type {
  CloudMutationAdapter,
  CloudMutationRequest,
  ProbeAttemptProposal,
} from "../src/probe-admission/index.ts";

const FIXED_ATTEMPT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const FIXED_NOW = new Date("2026-08-25T17:17:00.000Z");

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

async function admit(
  proposal: ProbeAttemptProposal,
  mutation = new RecordingCloudMutationAdapter(),
) {
  const evidenceRoot = await mkdtempRoot();
  const result = await admitProbeAttempt(proposal, {
    evidenceRoot,
    mutation,
    now: () => FIXED_NOW,
    createId: () => FIXED_ATTEMPT_ID,
  });
  return { result, evidenceRoot, mutation };
}

async function mkdtempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "probe-admission-"));
}

async function attemptEntries(evidenceRoot: string, id = FIXED_ATTEMPT_ID): Promise<string[]> {
  return readdir(join(evidenceRoot, "probe-attempts", id));
}

async function assertAdmittedLeavesNoEvidence(evidenceRoot: string): Promise<void> {
  await assert.rejects(
    () => readdir(join(evidenceRoot, "probe-attempts")),
    isEnoent,
  );
  assert.deepEqual(await readdir(evidenceRoot), []);
}

async function assertNoStaging(evidenceRoot: string): Promise<void> {
  try {
    const names = await readdir(join(evidenceRoot, "probe-attempts"));
    assert.equal(
      names.some((name) => name.includes(".staging")),
      false,
    );
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }
}

test("AC-14: admits the PoC full-refund BRL fixture and does not mutate or write artifacts", async () => {
  const { result, evidenceRoot, mutation } = await admit(validProposal());

  assert.equal(result.status, "admitted");
  if (result.status !== "admitted") {
    throw new Error("expected admitted result");
  }
  assert.equal(result.probe_attempt_id, FIXED_ATTEMPT_ID);
  assert.deepEqual(mutation.calls, []);
  await assertAdmittedLeavesNoEvidence(evidenceRoot);
});

test("AC-14: admits exact safe-integer full-refund amounts at the protocol maximum", async () => {
  const proposal = validProposal();
  proposal.payment.captured_amount_minor = MAX_SAFE_AMOUNT_MINOR;
  proposal.approved_decision.approved_amount_minor = MAX_SAFE_AMOUNT_MINOR;
  const { result, mutation, evidenceRoot } = await admit(proposal);

  assert.equal(result.status, "admitted");
  assert.deepEqual(mutation.calls, []);
  await assertAdmittedLeavesNoEvidence(evidenceRoot);
});

test("AC-14: admits Node 24 observations spelled with a leading v", async () => {
  const proposal = validProposal();
  proposal.tools.node_version = "v24.15.0";
  const { result, mutation, evidenceRoot } = await admit(proposal);

  assert.equal(result.status, "admitted");
  assert.deepEqual(mutation.calls, []);
  await assertAdmittedLeavesNoEvidence(evidenceRoot);
});

test("AC-14: rejects undeclared transport-probe safety durations", async () => {
  const proposal = validProposal();
  proposal.safety.active_probe_time_seconds = 600;
  proposal.safety.reserved_cleanup_seconds = 600;
  proposal.safety.total_target_seconds = 1100;
  const { result, mutation } = await admit(proposal);

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") {
    throw new Error("expected rejected result");
  }
  assert.equal(
    result.reasons.some((reason) => reason.code === "probe_duration_invalid"),
    true,
  );
  assert.deepEqual(mutation.calls, []);
});

test("AC-14: rejected attempts write only rejection and preflight journal", async () => {
  const proposal = validProposal();
  proposal.region = "us-west-2";
  const { result, evidenceRoot, mutation } = await admit(proposal);

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") {
    throw new Error("expected rejected result");
  }
  assert.equal(result.probe_attempt_id, FIXED_ATTEMPT_ID);
  assert.deepEqual(mutation.calls, []);
  assert.deepEqual(
    (await attemptEntries(evidenceRoot)).toSorted(),
    ["preflight-journal.jsonl", "probe-rejection.json"],
  );

  for (const name of [
    "probe-manifest.json",
    "transport-probe-manifest.json",
    "resource-manifest.json",
    "oracle-result.json",
    "package-index.json",
    "evidence-index.json",
  ]) {
    assert.equal((await attemptEntries(evidenceRoot)).includes(name), false);
  }

  const rejection = JSON.parse(
    await readFile(result.rejection_path, "utf8"),
  ) as {
    schema_version: number;
    record_type: string;
    probe_attempt_id: string;
    rejected_at: string;
    reasons: Array<{ code: string; category: string; expected: unknown; observed: unknown }>;
  };
  assert.equal(rejection.schema_version, 1);
  assert.equal(rejection.record_type, "probe_rejection");
  assert.equal(rejection.probe_attempt_id, FIXED_ATTEMPT_ID);
  assert.equal(rejection.rejected_at, "2026-08-25T17:17:00.000Z");
  const regionReason = result.reasons.find((reason) => reason.code === "region_not_allowed");
  assert.deepEqual(regionReason, {
    code: "region_not_allowed",
    category: "region",
    expected: ALLOWED_REGION,
    observed: "us-west-2",
  });

  const journal = await readFile(result.journal_path, "utf8");
  const lines = journal.trimEnd().split("\n");
  assert.equal(lines.length, 7);
  const rows = lines.map((line) => JSON.parse(line) as {
    schema_version: number;
    record_type: string;
    probe_attempt_id: string;
    occurred_at: string;
    check: string;
    result: string;
    reason_codes: string[];
  });
  for (const row of rows) {
    assert.equal(row.schema_version, 1);
    assert.equal(row.record_type, "preflight_check");
    assert.equal(row.probe_attempt_id, FIXED_ATTEMPT_ID);
    assert.equal(row.occurred_at, "2026-08-25T17:17:00.000Z");
    assert.ok(row.check);
    assert.ok(Array.isArray(row.reason_codes));
  }
  const regionRow = rows.find((row) => row.check === "region");
  assert.deepEqual(regionRow?.result, "rejected");
  assert.deepEqual(regionRow?.reason_codes, ["region_not_allowed"]);
  for (const row of rows) {
    if (row.check !== "region") {
      assert.equal(row.result, "passed");
      assert.deepEqual(row.reason_codes, []);
    }
  }
  await assertNoStaging(evidenceRoot);
});

test("AC-14: nested credential keys are rejected without logging secret values", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const proposal = validProposal();
  proposal.environment.nested = { password: "do-not-log" };
  proposal.environment.items = [{ access_key: "also-secret" }];
  proposal.environment.cycle = cyclic;
  proposal.environment.aws_access_key_id = "AKIAEXAMPLE";
  const { result, mutation } = await admit(proposal);

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") {
    throw new Error("expected rejected result");
  }
  const reason = result.reasons.find(
    (entry) => entry.code === "credentials_in_environment",
  );
  assert.deepEqual(reason?.observed, [
    "access_key",
    "aws_access_key_id",
    "password",
  ]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("do-not-log"), false);
  assert.equal(serialized.includes("also-secret"), false);
  const rejectionText = await readFile(result.rejection_path, "utf8");
  const journalText = await readFile(result.journal_path, "utf8");
  assert.equal(rejectionText.includes("do-not-log"), false);
  assert.equal(rejectionText.includes("also-secret"), false);
  assert.equal(journalText.includes("do-not-log"), false);
  assert.equal(journalText.includes("also-secret"), false);
  assert.deepEqual(mutation.calls, []);
});

test("AC-14: rejects zero, negative, fractional, unsafe, unequal, and non-BRL amounts", async () => {
  const cases: Array<{ name: string; mutate: (proposal: ProbeAttemptProposal) => void; code: string }> =
    [
      {
        name: "zero",
        mutate: (proposal) => {
          proposal.payment.captured_amount_minor = 0;
          proposal.approved_decision.approved_amount_minor = 0;
        },
        code: "amount_not_positive_integer",
      },
      {
        name: "negative",
        mutate: (proposal) => {
          proposal.payment.captured_amount_minor = -1;
          proposal.approved_decision.approved_amount_minor = -1;
        },
        code: "amount_not_positive_integer",
      },
      {
        name: "fractional",
        mutate: (proposal) => {
          proposal.payment.captured_amount_minor = 10000.5;
          proposal.approved_decision.approved_amount_minor = 10000.5;
        },
        code: "amount_not_positive_integer",
      },
      {
        name: "unsafe",
        mutate: (proposal) => {
          proposal.payment.captured_amount_minor = MAX_SAFE_AMOUNT_MINOR + 1;
          proposal.approved_decision.approved_amount_minor = MAX_SAFE_AMOUNT_MINOR + 1;
        },
        code: "amount_exceeds_safe_integer",
      },
      {
        name: "unequal",
        mutate: (proposal) => {
          proposal.approved_decision.approved_amount_minor = 9999;
        },
        code: "amounts_not_equal",
      },
      {
        name: "non-BRL",
        mutate: (proposal) => {
          proposal.payment.currency = "USD";
          proposal.approved_decision.currency = "USD";
        },
        code: "currency_not_brl",
      },
      {
        name: "currency mismatch",
        mutate: (proposal) => {
          proposal.approved_decision.currency = "USD";
        },
        code: "currency_mismatch",
      },
      {
        name: "payment schema_version",
        mutate: (proposal) => {
          proposal.payment.schema_version = 2;
        },
        code: "invalid_schema_version",
      },
      {
        name: "decision schema_version",
        mutate: (proposal) => {
          proposal.approved_decision.schema_version = 2;
        },
        code: "invalid_schema_version",
      },
      {
        name: "payment record_type",
        mutate: (proposal) => {
          proposal.payment.record_type = "invoice";
        },
        code: "invalid_record_type",
      },
      {
        name: "decision record_type",
        mutate: (proposal) => {
          proposal.approved_decision.record_type = "payment";
        },
        code: "invalid_record_type",
      },
      {
        name: "decision not APPROVED",
        mutate: (proposal) => {
          proposal.approved_decision.decision = "DENIED";
        },
        code: "decision_not_approved",
      },
    ];

  for (const testCase of cases) {
    const proposal = validProposal();
    testCase.mutate(proposal);
    const { result, mutation } = await admit(proposal);
    assert.equal(result.status, "rejected", testCase.name);
    if (result.status !== "rejected") {
      throw new Error("expected rejected result");
    }
    assert.equal(
      result.reasons.some((reason) => reason.code === testCase.code),
      true,
      testCase.name,
    );
    assert.deepEqual(mutation.calls, []);
  }
});

test("AC-14: rejects empty identifiers after trimming", async () => {
  const cases: Array<{ mutate: (proposal: ProbeAttemptProposal) => void }> = [
    { mutate: (proposal) => { proposal.payment.payment_id = ""; } },
    { mutate: (proposal) => { proposal.payment.payment_id = "   "; } },
    { mutate: (proposal) => { proposal.approved_decision.refund_request_id = ""; } },
    { mutate: (proposal) => { proposal.approved_decision.refund_request_id = "\t"; } },
    { mutate: (proposal) => { proposal.approved_decision.payment_id = " "; } },
  ];

  for (const testCase of cases) {
    const proposal = validProposal();
    testCase.mutate(proposal);
    const { result, mutation } = await admit(proposal);
    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") {
      throw new Error("expected rejected result");
    }
    assert.equal(
      result.reasons.some((reason) => reason.code === "identifier_empty"),
      true,
    );
    assert.deepEqual(mutation.calls, []);
  }
});

test("AC-14: rejects missing lockfile and missing revision", async () => {
  const missingRevision = validProposal();
  missingRevision.source.head_revision = "";
  const missingLockfile = validProposal();
  missingLockfile.source.lockfile_present = false;
  const untrackedLockfile = validProposal();
  untrackedLockfile.source.lockfile_tracked = false;

  for (const [proposal, code] of [
    [missingRevision, "revision_missing"],
    [missingLockfile, "lockfile_missing"],
    [untrackedLockfile, "lockfile_missing"],
  ] as const) {
    const { result, mutation } = await admit(proposal);
    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") {
      throw new Error("expected rejected result");
    }
    assert.equal(result.reasons.some((reason) => reason.code === code), true);
    assert.deepEqual(mutation.calls, []);
  }
});

test("AC-14: rejects invalid account, region, coordination, tool, and synthesis input", async () => {
  const cases: Array<{ mutate: (proposal: ProbeAttemptProposal) => void; code: string }> = [
    {
      mutate: (proposal) => {
        proposal.resolved_caller_account_id = "999999999999";
      },
      code: "account_not_allowlisted",
    },
    {
      mutate: (proposal) => {
        proposal.environment.allowlisted_account_id = "123";
      },
      code: "account_not_12_digit",
    },
    {
      mutate: (proposal) => {
        proposal.region = "eu-west-1";
      },
      code: "region_not_allowed",
    },
    {
      mutate: (proposal) => {
        proposal.environment.coordination_resource_arn =
          "arn:aws:dynamodb:us-west-2:123456789012:table/study-1-coordination";
      },
      code: "coordination_region_mismatch",
    },
    {
      mutate: (proposal) => {
        proposal.environment.coordination_resource_arn =
          "arn:aws:dynamodb:us-east-1:999999999999:table/study-1-coordination";
      },
      code: "coordination_account_mismatch",
    },
    {
      mutate: (proposal) => {
        proposal.environment.coordination_resource_arn =
          "arn:aws::us-east-1:123456789012:";
      },
      code: "coordination_arn_invalid",
    },
    {
      mutate: (proposal) => {
        proposal.environment.coordination_resource_arn =
          "arn:aws:dynamodb:us-east-1:123456789012:";
      },
      code: "coordination_arn_invalid",
    },
    {
      mutate: (proposal) => {
        proposal.tools.node_version = "22.14.0";
      },
      code: "node_version_unsupported",
    },
    {
      mutate: (proposal) => {
        proposal.tools.node_version = "v22.14.0";
      },
      code: "node_version_unsupported",
    },
    {
      mutate: (proposal) => {
        proposal.tools.node_version = "24garbage";
      },
      code: "node_version_unsupported",
    },
    {
      mutate: (proposal) => {
        proposal.tools.node_version = "v24foo";
      },
      code: "node_version_unsupported",
    },
    {
      mutate: (proposal) => {
        proposal.tools.node_version = "24.15.0rc";
      },
      code: "node_version_unsupported",
    },
    {
      mutate: (proposal) => {
        proposal.tools.node_version = "24.15.0\n";
      },
      code: "node_version_unsupported",
    },
    {
      mutate: (proposal) => {
        proposal.tools.node_version = "24.15.0\r";
      },
      code: "node_version_unsupported",
    },
    {
      mutate: (proposal) => {
        proposal.tools.node_version = "v24.15.0\n";
      },
      code: "node_version_unsupported",
    },
    {
      mutate: (proposal) => {
        proposal.tools.node_version = "240.0.0";
      },
      code: "node_version_unsupported",
    },
    {
      mutate: (proposal) => {
        proposal.tools.node_version = "24";
      },
      code: "node_version_unsupported",
    },
    {
      mutate: (proposal) => {
        proposal.tools.node_version = "24.15";
      },
      code: "node_version_unsupported",
    },
    {
      mutate: (proposal) => {
        proposal.tools.node_version = "v24.15";
      },
      code: "node_version_unsupported",
    },
    {
      mutate: (proposal) => {
        proposal.synthesis = undefined;
      },
      code: "synthesis_input_missing",
    },
    {
      mutate: (proposal) => {
        proposal.synthesis = {
          files: [{ path: "../secret", kind: "symlink" }],
        };
      },
      code: "synthesis_file_kind_rejected",
    },
    {
      mutate: (proposal) => {
        proposal.safety.estimated_attributable_usage_usd_minor =
          PROBE_USAGE_CEILING_USD_MINOR + 1;
      },
      code: "estimated_cost_exceeds_ceiling",
    },
    {
      mutate: (proposal) => {
        proposal.safety.ownership_strategy = "  ";
      },
      code: "ownership_strategy_missing",
    },
    {
      mutate: (proposal) => {
        proposal.environment.aws_access_key_id = "AKIAEXAMPLE";
      },
      code: "credentials_in_environment",
    },
    {
      mutate: (proposal) => {
        proposal.environment.nested = { password: "do-not-log" };
      },
      code: "credentials_in_environment",
    },
    {
      mutate: (proposal) => {
        proposal.approved_decision.payment_id = "pay-other";
      },
      code: "payment_id_mismatch",
    },
    {
      mutate: (proposal) => {
        proposal.synthesis = { files: "not-an-array" };
      },
      code: "synthesis_files_invalid",
    },
    {
      mutate: (proposal) => {
        proposal.synthesis = { files: ["not-an-object"] };
      },
      code: "synthesis_file_invalid",
    },
  ];

  for (const testCase of cases) {
    const proposal = validProposal();
    testCase.mutate(proposal);
    const { result, mutation } = await admit(proposal);
    assert.equal(result.status, "rejected", testCase.code);
    if (result.status !== "rejected") {
      throw new Error("expected rejected result");
    }
    assert.equal(
      result.reasons.some((reason) => reason.code === testCase.code),
      true,
      testCase.code,
    );
    assert.deepEqual(mutation.calls, []);
  }
});

test("AC-14: rejected bigint amounts still write JSON-safe rejection evidence with matching returned reasons", async () => {
  const proposal = validProposal();
  proposal.payment.captured_amount_minor = 1n;
  proposal.approved_decision.approved_amount_minor = 1n;
  const { result, evidenceRoot, mutation } = await admit(proposal);

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") {
    throw new Error("expected rejected result");
  }
  assert.equal(
    result.reasons.some((reason) => reason.code === "amount_not_positive_integer"),
    true,
  );
  assert.deepEqual(
    (await attemptEntries(evidenceRoot)).toSorted(),
    ["preflight-journal.jsonl", "probe-rejection.json"],
  );
  const rejection = JSON.parse(await readFile(result.rejection_path, "utf8")) as {
    reasons: Array<{ code: string; observed: unknown }>;
  };
  assert.deepEqual(result.reasons, rejection.reasons);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(
    rejection.reasons.some((reason) => reason.observed === "1"),
    true,
  );
  assert.deepEqual(mutation.calls, []);
  await assertNoStaging(evidenceRoot);
});

test("AC-14: JSON-safe reasons serialize shared references and ancestor cycles", async () => {
  const shared = { tag: "shared" };
  const diamondProposal = validProposal();
  diamondProposal.payment.currency = { left: shared, right: shared };
  diamondProposal.approved_decision.currency = ALLOWED_CURRENCY;
  const diamond = await admit(diamondProposal);

  assert.equal(diamond.result.status, "rejected");
  if (diamond.result.status !== "rejected") {
    throw new Error("expected rejected result");
  }
  const diamondReason = diamond.result.reasons.find(
    (reason) => reason.code === "currency_not_brl",
  );
  assert.deepEqual(diamondReason?.observed, {
    left: { tag: "shared" },
    right: { tag: "shared" },
  });
  const diamondRejection = JSON.parse(
    await readFile(diamond.result.rejection_path, "utf8"),
  ) as { reasons: Array<{ code: string; observed: unknown }> };
  assert.deepEqual(
    diamondRejection.reasons.find((reason) => reason.code === "currency_not_brl")
      ?.observed,
    { left: { tag: "shared" }, right: { tag: "shared" } },
  );
  assert.deepEqual(diamond.mutation.calls, []);

  const cyclic: Record<string, unknown> = { tag: "cycle" };
  cyclic.self = cyclic;
  const cycleProposal = validProposal();
  cycleProposal.payment.currency = cyclic;
  cycleProposal.approved_decision.currency = ALLOWED_CURRENCY;
  const cycle = await admit(cycleProposal);

  assert.equal(cycle.result.status, "rejected");
  if (cycle.result.status !== "rejected") {
    throw new Error("expected rejected result");
  }
  const cycleReason = cycle.result.reasons.find(
    (reason) => reason.code === "currency_not_brl",
  );
  assert.deepEqual(cycleReason?.observed, { tag: "cycle", self: "[Circular]" });
  const cycleRejection = JSON.parse(
    await readFile(cycle.result.rejection_path, "utf8"),
  ) as { reasons: Array<{ code: string; observed: unknown }> };
  assert.deepEqual(
    cycleRejection.reasons.find((reason) => reason.code === "currency_not_brl")
      ?.observed,
    { tag: "cycle", self: "[Circular]" },
  );
  assert.doesNotThrow(() => JSON.stringify(cycle.result));
  assert.deepEqual(cycle.mutation.calls, []);
});

test("AC-14: rejection reasons stay JSON-identical for unsupported synthesis values", async () => {
  function secretFn() {
    return "do-not-leak";
  }
  const leakSym = Symbol("do-not-leak");
  const proposal = validProposal();
  proposal.synthesis = { files: [secretFn, leakSym, undefined] };
  const { result, mutation } = await admit(proposal);

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") {
    throw new Error("expected rejected result");
  }
  const rejection = JSON.parse(await readFile(result.rejection_path, "utf8")) as {
    reasons: unknown;
  };
  assert.deepEqual(rejection.reasons, result.reasons);
  const serialized = JSON.stringify(result);
  assert.doesNotThrow(() => JSON.parse(serialized));
  assert.equal(serialized.includes("do-not-leak"), false);
  assert.equal(serialized.includes("secretFn"), false);
  const rejectionText = await readFile(result.rejection_path, "utf8");
  assert.equal(rejectionText.includes("do-not-leak"), false);
  assert.equal(rejectionText.includes("secretFn"), false);
  assert.deepEqual(
    result.reasons
      .filter((reason) => reason.code === "synthesis_file_invalid")
      .map((reason) => reason.observed),
    [
      { index: 0, file: "[Function]" },
      { index: 1, file: "[Symbol]" },
      { index: 2, file: "[Undefined]" },
    ],
  );
  assert.deepEqual(mutation.calls, []);
});

test("AC-14: JSON-safe reasons fill sparse array holes without leaking values", async () => {
  const sparse: unknown[] = [];
  sparse[1] = function secretFn() {
    return "do-not-leak";
  };
  const proposal = validProposal();
  proposal.payment.currency = sparse;
  proposal.approved_decision.currency = ALLOWED_CURRENCY;
  const { result, mutation } = await admit(proposal);

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") {
    throw new Error("expected rejected result");
  }
  const reason = result.reasons.find((entry) => entry.code === "currency_not_brl");
  assert.deepEqual(reason?.observed, ["[Undefined]", "[Function]"]);
  const rejection = JSON.parse(await readFile(result.rejection_path, "utf8")) as {
    reasons: Array<{ code: string; observed: unknown }>;
  };
  assert.deepEqual(rejection.reasons, result.reasons);
  const serialized = JSON.stringify(result);
  assert.equal(JSON.stringify(reason?.observed).includes("null"), false);
  assert.equal(serialized.includes("do-not-leak"), false);
  assert.equal(serialized.includes("secretFn"), false);
  assert.deepEqual(mutation.calls, []);
});

test("AC-14: JSON-safe reasons canonicalize -0, NaN, and Infinity", async () => {
  const proposal = validProposal();
  proposal.payment.currency = { zero: -0, nan: Number.NaN, inf: Number.POSITIVE_INFINITY };
  proposal.approved_decision.currency = ALLOWED_CURRENCY;
  const { result, mutation } = await admit(proposal);

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") {
    throw new Error("expected rejected result");
  }
  const reason = result.reasons.find((entry) => entry.code === "currency_not_brl");
  const observed = reason?.observed as { zero: number; nan: string; inf: string };
  assert.deepEqual(observed, { zero: 0, nan: "NaN", inf: "Infinity" });
  assert.equal(Object.is(observed.zero, 0), true);
  assert.equal(Object.is(observed.zero, -0), false);
  const rejection = JSON.parse(await readFile(result.rejection_path, "utf8")) as {
    reasons: unknown;
  };
  assert.deepEqual(rejection.reasons, result.reasons);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.deepEqual(mutation.calls, []);
});

test("AC-14: a failed promotion leaves no staging artifacts", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const evidenceRoot = await mkdtempRoot();
  const probeAttemptsDir = join(evidenceRoot, "probe-attempts");
  await mkdir(probeAttemptsDir, { recursive: true });
  await writeFile(join(probeAttemptsDir, FIXED_ATTEMPT_ID), "occupied");
  const proposal = validProposal();
  proposal.region = "us-west-2";

  await assert.rejects(
    () =>
      admitProbeAttempt(proposal, {
        evidenceRoot,
        mutation,
        now: () => FIXED_NOW,
        createId: () => FIXED_ATTEMPT_ID,
      }),
    (error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR";
    },
  );
  await assertNoStaging(evidenceRoot);
  assert.deepEqual(mutation.calls, []);
});

test("AC-14: leftover staging is replaced so rejection publishes only required evidence", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const evidenceRoot = await mkdtempRoot();
  const probeAttemptsDir = join(evidenceRoot, "probe-attempts");
  const stagingDir = join(probeAttemptsDir, `.${FIXED_ATTEMPT_ID}.staging`);
  await mkdir(stagingDir, { recursive: true });
  await writeFile(join(stagingDir, "probe-manifest.json"), "{}\n");
  await writeFile(join(stagingDir, "extra.txt"), "residue");
  const proposal = validProposal();
  proposal.region = "us-west-2";

  const result = await admitProbeAttempt(proposal, {
    evidenceRoot,
    mutation,
    now: () => FIXED_NOW,
    createId: () => FIXED_ATTEMPT_ID,
  });

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") {
    throw new Error("expected rejected result");
  }
  assert.deepEqual(
    (await attemptEntries(evidenceRoot)).toSorted(),
    ["preflight-journal.jsonl", "probe-rejection.json"],
  );
  await assertNoStaging(evidenceRoot);
  assert.deepEqual(mutation.calls, []);
});

test("AC-14: collects independent faults without fail-fast", async () => {
  const proposal = validProposal();
  proposal.region = "us-west-2";
  proposal.tools.node_version = "22.14.0";
  const { result, mutation } = await admit(proposal);

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") {
    throw new Error("expected rejected result");
  }
  const region = result.reasons.find((reason) => reason.code === "region_not_allowed");
  const tool = result.reasons.find((reason) => reason.code === "node_version_unsupported");
  assert.deepEqual(region, {
    code: "region_not_allowed",
    category: "region",
    expected: ALLOWED_REGION,
    observed: "us-west-2",
  });
  assert.deepEqual(tool, {
    code: "node_version_unsupported",
    category: "tool",
    expected: "24.x.y or v24.x.y",
    observed: "22.14.0",
  });
  const rejection = JSON.parse(await readFile(result.rejection_path, "utf8")) as {
    reasons: unknown;
  };
  assert.deepEqual(rejection.reasons, result.reasons);
  assert.deepEqual(mutation.calls, []);
});

test("AC-14: rejects unnormalized synthesis paths", async () => {
  const paths = [
    "../secret",
    "foo/../bar.json",
    "foo/./bar.json",
    "foo//bar.json",
    "/absolute/path.json",
    "windows\\path.json",
    "C:assembly.json",
    ".",
    "..",
  ];

  for (const path of paths) {
    const proposal = validProposal();
    proposal.synthesis = { files: [{ path, kind: "regular" }] };
    const { result, mutation } = await admit(proposal);
    assert.equal(result.status, "rejected", path);
    if (result.status !== "rejected") {
      throw new Error("expected rejected result");
    }
    assert.equal(
      result.reasons.some((reason) => reason.code === "synthesis_path_invalid"),
      true,
      path,
    );
    assert.deepEqual(mutation.calls, []);
  }
});

test("AC-14: rejects synthesis credentials, container-image assets, coordination, safety, and identity faults", async () => {
  const cases: Array<{ mutate: (proposal: ProbeAttemptProposal) => void; code: string }> = [
    {
      mutate: (proposal) => {
        proposal.synthesis = {
          files: [{ path: "assembly/template.json", kind: "regular" }],
          credential_process: "aws-vault exec",
        };
      },
      code: "credentials_in_synthesis",
    },
    {
      mutate: (proposal) => {
        proposal.synthesis = {
          files: [{ path: "assembly/image", kind: "container_image" }],
        };
      },
      code: "synthesis_file_kind_rejected",
    },
    {
      mutate: (proposal) => {
        proposal.environment.coordination_stack_identity = "  ";
      },
      code: "coordination_stack_identity_empty",
    },
    {
      mutate: (proposal) => {
        proposal.environment.expected_coordination_schema_version = 2;
      },
      code: "coordination_schema_version_mismatch",
    },
    {
      mutate: (proposal) => {
        proposal.safety.active_probe_time_seconds = 601;
      },
      code: "probe_duration_invalid",
    },
    {
      mutate: (proposal) => {
        proposal.safety.reserved_cleanup_seconds = 601;
      },
      code: "probe_duration_invalid",
    },
    {
      mutate: (proposal) => {
        proposal.safety.total_target_seconds = 1201;
      },
      code: "probe_duration_invalid",
    },
    {
      mutate: (proposal) => {
        proposal.safety.active_probe_time_seconds = 0;
      },
      code: "probe_duration_invalid",
    },
    {
      mutate: (proposal) => {
        proposal.safety.stabilization_interval_seconds = 0;
      },
      code: "probe_duration_invalid",
    },
    {
      mutate: (proposal) => {
        proposal.safety.stabilization_interval_seconds = 121;
      },
      code: "probe_duration_invalid",
    },
    {
      mutate: (proposal) => {
        proposal.safety.estimated_attributable_usage_usd_minor = -1;
      },
      code: "estimated_cost_invalid",
    },
    {
      mutate: (proposal) => {
        proposal.safety.estimated_attributable_usage_usd_minor = 101;
      },
      code: "estimated_cost_exceeds_ceiling",
    },
  ];

  for (const testCase of cases) {
    const proposal = validProposal();
    testCase.mutate(proposal);
    const { result, mutation } = await admit(proposal);
    assert.equal(result.status, "rejected", testCase.code);
    if (result.status !== "rejected") {
      throw new Error("expected rejected result");
    }
    assert.equal(
      result.reasons.some((reason) => reason.code === testCase.code),
      true,
      testCase.code,
    );
    assert.deepEqual(mutation.calls, []);
  }
});

test("AC-14: default identity is a lowercase UUIDv4 and writes nothing on admit", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const evidenceRoot = await mkdtempRoot();
  const result = await admitProbeAttempt(validProposal(), {
    evidenceRoot,
    mutation,
    now: () => FIXED_NOW,
  });

  assert.equal(result.status, "admitted");
  if (result.status !== "admitted") {
    throw new Error("expected admitted result");
  }
  assert.equal(isLowercaseUuidV4(result.probe_attempt_id), true);
  await assertAdmittedLeavesNoEvidence(evidenceRoot);
  assert.deepEqual(mutation.calls, []);
});

test("AC-14: invalid injected UUID rejects before any attempt writes", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const evidenceRoot = await mkdtempRoot();

  await assert.rejects(
    () =>
      admitProbeAttempt(validProposal(), {
        evidenceRoot,
        mutation,
        now: () => FIXED_NOW,
        createId: () => "not-a-uuid",
      }),
    /lowercase UUIDv4/,
  );
  await assert.rejects(() => readdir(join(evidenceRoot, "probe-attempts")), isEnoent);
  assert.deepEqual(mutation.calls, []);
});

test("AC-14: injected mutation adapter remains untouched across accept and reject", async () => {
  const mutation = new RecordingCloudMutationAdapter();
  const accepted = await admit(validProposal(), mutation);
  const rejectedProposal = validProposal();
  rejectedProposal.payment.captured_amount_minor = 0;
  rejectedProposal.approved_decision.approved_amount_minor = 0;
  const rejected = await admit(rejectedProposal, mutation);

  assert.equal(accepted.result.status, "admitted");
  await assertAdmittedLeavesNoEvidence(accepted.evidenceRoot);
  assert.equal(rejected.result.status, "rejected");
  assert.deepEqual(mutation.calls, []);
});

test("AC-14: null synthesis input is missing rather than thrown", async () => {
  const proposal = validProposal();
  proposal.synthesis = null;
  const { result, evidenceRoot, mutation } = await admit(proposal);

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") {
    throw new Error("expected rejected result");
  }
  assert.equal(
    result.reasons.some((reason) => reason.code === "synthesis_input_missing"),
    true,
  );
  assert.deepEqual(
    (await attemptEntries(evidenceRoot)).toSorted(),
    ["preflight-journal.jsonl", "probe-rejection.json"],
  );
  assert.deepEqual(mutation.calls, []);
});
