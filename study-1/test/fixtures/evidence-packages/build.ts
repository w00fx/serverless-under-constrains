import { serializeCanonicalJson, serializeCanonicalJsonl, sha256Hex } from "../../../src/protocol-records/index.ts";
import {
  CHECKPOINT_PATH,
  JOURNAL_PATH,
  createPackageStore,
  createPrefixCheckpoint,
  putUtf8,
  writeEvidenceIndex,
  writePackageIndex,
} from "../../../src/evidence-packages/index.ts";
import type { PackageStore } from "../../../src/evidence-packages/index.ts";

export const NOW = "2026-08-31T21:00:00.000Z";
export const EVENT_ONE = "11111111-1111-4111-8111-111111111111";
export const EVENT_TWO = "22222222-2222-4222-8222-222222222222";

export function requireOk<T>(result: { ok: true; value: T } | { ok: false; reasons: readonly string[] }, label: string): T {
  if (!result.ok) {
    throw new Error(`${label}: ${result.reasons.join(",")}`);
  }
  return result.value;
}

export function journalRecords(): readonly Record<string, unknown>[] {
  return [
    { event_id: EVENT_ONE, source_sequence: 1 },
    { event_id: EVENT_TWO, source_sequence: 2 },
  ];
}

export function putCanonical(store: PackageStore, path: string, value: unknown): Uint8Array {
  return requireOk(putUtf8(store, path, requireOk(serializeCanonicalJson(value), path)), path);
}

function putJournal(store: PackageStore): { prefix: Uint8Array; complete: string } {
  const records = journalRecords();
  const prefixText = requireOk(serializeCanonicalJsonl(records.slice(0, 1)), "journal-prefix");
  const complete = requireOk(serializeCanonicalJsonl(records), "journal");
  requireOk(putUtf8(store, JOURNAL_PATH, complete), JOURNAL_PATH);
  return { prefix: new TextEncoder().encode(prefixText), complete };
}

function putCheckpoint(store: PackageStore, prefix: Uint8Array): void {
  const checkpoint = requireOk(
    createPrefixCheckpoint({
      schema_version: 1,
      record_type: "coordination_prefix_checkpoint",
      path: JOURNAL_PATH,
      prefix_byte_count: prefix.byteLength,
      prefix_digest: sha256Hex(prefix),
      last_included_event_id: EVENT_ONE,
      last_included_sequence: 1,
      checkpoint_time: NOW,
    }),
    "checkpoint",
  );
  putCanonical(store, CHECKPOINT_PATH, checkpoint);
}

const PROBE_PRIMARY = [
  "primary/execution-manifest.json",
  "primary/provider-events.jsonl",
  "primary/assembly/inventory.json",
] as const;

const VALIDATION_PRIMARY = [
  "primary/execution-manifest.json",
  "primary/trial-manifest.json",
  "primary/inputs/payment.json",
  "primary/inputs/approved-decision.json",
  "primary/inputs/published-message.json",
  "primary/journals/caller.jsonl",
  "primary/journals/variant.jsonl",
  "primary/journals/provider.jsonl",
  "primary/journals/treatment.jsonl",
  "primary/ledger/snapshot.json",
  "primary/queues/source-observations.json",
  "primary/queues/dlq-observations.json",
  "primary/queues/correlated-dlq-snapshot.json",
  "primary/execution/authoritative-record.json",
  "primary/assembly/inventory.json",
] as const;

function classifyPrimary(paths: readonly string[]): Record<string, "primary" | "derived"> {
  const classifications: Record<string, "primary" | "derived"> = {};
  for (const path of paths) {
    classifications[path] = "primary";
  }
  classifications[CHECKPOINT_PATH] = "primary";
  return classifications;
}

export function finalize(store: PackageStore, classifications: Record<string, "primary" | "derived">): PackageStore {
  requireOk(writeEvidenceIndex(store, classifications), "evidence-index");
  requireOk(writePackageIndex(store), "package-index");
  return store;
}

export function buildEligibleProbe(): PackageStore {
  const store = createPackageStore();
  for (const path of PROBE_PRIMARY) {
    putCanonical(store, path, { artifact: path });
  }
  const { prefix } = putJournal(store);
  putCheckpoint(store, prefix);
  putCanonical(store, "derived/probe-summary.json", { record_type: "probe_summary" });
  putCanonical(store, "late-evidence/arrival.json", { late: true });
  const classifications = classifyPrimary(PROBE_PRIMARY);
  classifications["derived/probe-summary.json"] = "derived";
  return finalize(store, classifications);
}

export function buildEligibleValidation(): PackageStore {
  const store = createPackageStore();
  for (const path of VALIDATION_PRIMARY) {
    if (path === "primary/ledger/snapshot.json") {
      putCanonical(store, path, { trial_id: "trial-1" });
      continue;
    }
    if (path === "primary/journals/provider.jsonl") {
      requireOk(
        putUtf8(store, path, requireOk(serializeCanonicalJsonl(journalRecords()), path)),
        path,
      );
      continue;
    }
    putCanonical(store, path, { artifact: path });
  }
  const { prefix } = putJournal(store);
  putCheckpoint(store, prefix);
  const snapshot = store.get("primary/ledger/snapshot.json");
  const providerJournal = store.get("primary/journals/provider.jsonl");
  if (snapshot === undefined || providerJournal === undefined) {
    throw new Error("snapshot");
  }
  putCanonical(store, "derived/attempt-projection.json", { record_type: "attempt_projection" });
  putCanonical(store, "derived/oracle-result.json", {
    schema_version: 1,
    record_type: "oracle_result",
    evidence_refs: [
      {
        artifact_path: "primary/ledger/snapshot.json",
        artifact_sha256: sha256Hex(snapshot),
        json_pointer: "/trial_id",
      },
      {
        artifact_path: "primary/journals/provider.jsonl",
        artifact_sha256: sha256Hex(providerJournal),
        event_id: EVENT_ONE,
      },
    ],
  });
  putCanonical(store, "derived/validation-summary.json", { record_type: "validation_summary" });
  putCanonical(store, "late-evidence/arrival.json", { late: true });
  const classifications = classifyPrimary(VALIDATION_PRIMARY);
  classifications["derived/attempt-projection.json"] = "derived";
  classifications["derived/oracle-result.json"] = "derived";
  classifications["derived/validation-summary.json"] = "derived";
  return finalize(store, classifications);
}
