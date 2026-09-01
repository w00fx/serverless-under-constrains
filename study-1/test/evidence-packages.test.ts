import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sha256Hex } from "../src/protocol-records/index.ts";
import {
  CHECKPOINT_PATH,
  EVIDENCE_INDEX_PATH,
  JOURNAL_PATH,
  PACKAGE_INDEX_PATH,
  createPackageStore,
  createPrefixCheckpoint,
  loadPackageDir,
  putUtf8,
  savePackageDir,
  verifyOriginalPackage,
  writeEvidenceIndex,
  writePackageIndex,
} from "../src/evidence-packages/index.ts";
import { jsonPointerExists } from "../src/evidence-packages/references.ts";
import { parseEvidenceIndex, parsePackageIndex } from "../src/evidence-packages/entries.ts";
import {
  EVENT_ONE,
  NOW,
  buildEligibleProbe,
  buildEligibleValidation,
  putCanonical,
  requireOk,
} from "./fixtures/evidence-packages/build.ts";

const now = (): string => NOW;

function verify(store: Map<string, Uint8Array>, head: unknown = null) {
  return requireOk(
    verifyOriginalPackage(store, { selected_amendment_head_sha256: head, now }),
    "verify",
  );
}

describe("original evidence packages", () => {
  it("finalizes and verifies an eligible probe with a prefix checkpoint", () => {
    const store = buildEligibleProbe();
    const result = verify(store);
    assert.equal(result.package_eligibility, "eligible");
    assert.deepEqual(result.package_ineligibility_reasons, []);
    assert.equal(result.selected_amendment_head_sha256, null);
    assert.equal(result.evaluated_at, NOW);
    const packageBytes = store.get(PACKAGE_INDEX_PATH);
    const evidenceBytes = store.get(EVIDENCE_INDEX_PATH);
    assert.notEqual(packageBytes, undefined);
    assert.notEqual(evidenceBytes, undefined);
    assert.equal(result.original_package_index_sha256, sha256Hex(packageBytes as Uint8Array));
    const evidence = requireOk(
      parseEvidenceIndex(JSON.parse(new TextDecoder().decode(evidenceBytes as Uint8Array))),
      "ei",
    );
    assert.equal(evidence.entries.some((entry) => entry.artifact_path === JOURNAL_PATH), false);
    assert.equal(evidence.entries.some((entry) => entry.artifact_path === CHECKPOINT_PATH), true);
    assert.equal(evidence.entries.some((entry) => entry.artifact_path.startsWith("late-evidence/")), false);
    const pack = requireOk(
      parsePackageIndex(JSON.parse(new TextDecoder().decode(packageBytes as Uint8Array))),
      "pi",
    );
    assert.equal(pack.entries.some((entry) => entry.artifact_path === JOURNAL_PATH), true);
    assert.equal(pack.entries.some((entry) => entry.artifact_path === PACKAGE_INDEX_PATH), false);
  });

  it("indexes a closed journal when no checkpoint is present", () => {
    const store = createPackageStore();
    putCanonical(store, "primary/execution-manifest.json", { artifact: "manifest" });
    requireOk(putUtf8(store, JOURNAL_PATH, '{"event_id":"11111111-1111-4111-8111-111111111111","source_sequence":1}\n'), "journal");
    requireOk(
      writeEvidenceIndex(store, {
        "primary/execution-manifest.json": "primary",
        [JOURNAL_PATH]: "primary",
      }),
      "ei",
    );
    requireOk(writePackageIndex(store), "pi");
    const evidence = requireOk(parseEvidenceIndex(JSON.parse(new TextDecoder().decode(store.get(EVIDENCE_INDEX_PATH)))), "parse");
    assert.equal(evidence.entries.some((entry) => entry.artifact_path === JOURNAL_PATH), true);
    assert.equal(verify(store).package_eligibility, "eligible");
  });

  it("finalizes an AC-10 validation package with resolvable references", () => {
    const result = verify(buildEligibleValidation());
    assert.equal(result.package_eligibility, "eligible");
  });

  it("refuses to rewrite indexes", () => {
    const store = buildEligibleProbe();
    const rewriteEvidence = writeEvidenceIndex(store, {});
    assert.equal(rewriteEvidence.ok, false);
    if (!rewriteEvidence.ok) {
      assert.deepEqual(rewriteEvidence.reasons, ["rewrite_forbidden"]);
    }
    const second = writePackageIndex(store);
    assert.equal(second.ok, false);
    if (second.ok) {
      return;
    }
    assert.deepEqual(second.reasons, ["rewrite_forbidden"]);
  });

  it("requires the evidence index before the package index", () => {
    const missing = writePackageIndex(createPackageStore());
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.deepEqual(missing.reasons, ["missing_evidence_index"]);
    }
    assert.equal(writePackageIndex({}).ok, false);
    assert.equal(writeEvidenceIndex({}, {}).ok, false);
  });

  it("rejects reserved-path misuse and missing classifications", () => {
    const store = createPackageStore();
    putCanonical(store, "primary/execution-manifest.json", { artifact: "manifest" });
    putCanonical(store, "late-evidence/arrival.json", { late: true });
    const missing = writeEvidenceIndex(store, {});
    assert.equal(missing.ok, false);
    const late = writeEvidenceIndex(store, {
      "primary/execution-manifest.json": "primary",
      "late-evidence/arrival.json": "primary",
    });
    assert.equal(late.ok, false);
    if (!late.ok) {
      assert.equal(late.reasons.includes("invalid_classification"), true);
    }
    const derivedJournal = writeEvidenceIndex(store, {
      "primary/execution-manifest.json": "primary",
      [JOURNAL_PATH]: "derived",
    });
    assert.equal(derivedJournal.ok, false);
    store.set("../escape", new Uint8Array([1]));
    const badPath = writeEvidenceIndex(store, { "primary/execution-manifest.json": "primary" });
    assert.equal(badPath.ok, false);
    if (!badPath.ok) {
      assert.equal(badPath.reasons.includes("invalid_path"), true);
    }
  });

  it("rejects a checkpoint without an aligned journal", () => {
    const store = createPackageStore();
    putCanonical(store, CHECKPOINT_PATH, { not: "a checkpoint" });
    putCanonical(store, "primary/execution-manifest.json", { artifact: "manifest" });
    const malformed = writeEvidenceIndex(store, {
      "primary/execution-manifest.json": "primary",
      [CHECKPOINT_PATH]: "primary",
    });
    assert.equal(malformed.ok, false);
    if (!malformed.ok) {
      assert.equal(malformed.reasons.includes("malformed_checkpoint") || malformed.reasons.includes("missing_file"), true);
    }
  });

  it("makes missing files, digest changes, and extra files ineligible", () => {
    const missing = verify(createPackageStore());
    assert.equal(missing.package_eligibility, "ineligible");
    assert.equal(missing.package_ineligibility_reasons.includes("missing_file"), true);
    const digestStore = buildEligibleProbe();
    requireOk(putUtf8(digestStore, "primary/execution-manifest.json", "{\"mutated\":true}\n"), "mutate");
    const digest = verify(digestStore);
    assert.equal(digest.package_ineligibility_reasons.includes("digest_mismatch"), true);
    const extra = buildEligibleProbe();
    putCanonical(extra, "primary/extra.json", { extra: true });
    const incomplete = verify(extra);
    assert.equal(incomplete.package_ineligibility_reasons.includes("package_index_incomplete"), true);
    assert.equal(incomplete.package_ineligibility_reasons.includes("evidence_index_incomplete"), true);
  });

  it("rejects self-indexing, late evidence in the evidence index, and a selected amendment", () => {
    const selfEvidence = buildEligibleProbe();
    const evidenceBytes = selfEvidence.get(EVIDENCE_INDEX_PATH);
    assert.notEqual(evidenceBytes, undefined);
    const evidence = requireOk(parseEvidenceIndex(JSON.parse(new TextDecoder().decode(evidenceBytes))), "ei");
    evidence.entries.push({
      artifact_path: EVIDENCE_INDEX_PATH,
      artifact_sha256: sha256Hex(evidenceBytes as Uint8Array),
      byte_count: (evidenceBytes as Uint8Array).byteLength,
      classification: "derived",
    });
    putCanonical(selfEvidence, EVIDENCE_INDEX_PATH, evidence);
    const selfE = verify(selfEvidence);
    assert.equal(selfE.package_ineligibility_reasons.includes("self_indexed_evidence_index"), true);
    const selfPackage = buildEligibleProbe();
    const packageBytes = selfPackage.get(PACKAGE_INDEX_PATH);
    const pack = requireOk(parsePackageIndex(JSON.parse(new TextDecoder().decode(packageBytes))), "pi");
    pack.entries.push({
      artifact_path: PACKAGE_INDEX_PATH,
      artifact_sha256: sha256Hex(packageBytes as Uint8Array),
      byte_count: (packageBytes as Uint8Array).byteLength,
    });
    putCanonical(selfPackage, PACKAGE_INDEX_PATH, pack);
    const selfP = verify(selfPackage);
    assert.equal(selfP.package_ineligibility_reasons.includes("self_indexed_package_index"), true);
    const late = buildEligibleProbe();
    const lateEvidence = requireOk(
      parseEvidenceIndex(JSON.parse(new TextDecoder().decode(late.get(EVIDENCE_INDEX_PATH)))),
      "late",
    );
    const arrival = late.get("late-evidence/arrival.json");
    assert.notEqual(arrival, undefined);
    lateEvidence.entries.push({
      artifact_path: "late-evidence/arrival.json",
      artifact_sha256: sha256Hex(arrival as Uint8Array),
      byte_count: (arrival as Uint8Array).byteLength,
      classification: "primary",
    });
    putCanonical(late, EVIDENCE_INDEX_PATH, lateEvidence);
    const lateResult = verify(late);
    assert.equal(lateResult.package_ineligibility_reasons.includes("late_evidence_in_evidence_index"), true);
    const amended = verify(buildEligibleProbe(), sha256Hex("amendment"));
    assert.equal(amended.package_eligibility, "ineligible");
    assert.equal(amended.package_ineligibility_reasons.includes("selected_amendment_unsupported"), true);
  });

  it("rejects unresolved, conflicting, and malformed references", () => {
    const unresolved = buildEligibleProbe();
    putCanonical(unresolved, "derived/probe-summary.json", {
      evidence_refs: [{ artifact_path: "primary/missing.json", artifact_sha256: sha256Hex("x") }],
    });
    const missingRef = verify(unresolved);
    assert.equal(missingRef.package_ineligibility_reasons.includes("unresolved_reference"), true);
    const pointer = buildEligibleValidation();
    putCanonical(pointer, "derived/oracle-result.json", {
      schema_version: 1,
      record_type: "oracle_result",
      evidence_refs: [
        {
          artifact_path: "primary/ledger/snapshot.json",
          artifact_sha256: sha256Hex(pointer.get("primary/ledger/snapshot.json") as Uint8Array),
          json_pointer: "/missing",
        },
      ],
    });
    const badPointer = verify(pointer);
    assert.equal(badPointer.package_ineligibility_reasons.includes("unresolved_reference"), true);
    const event = buildEligibleValidation();
    putCanonical(event, "derived/oracle-result.json", {
      schema_version: 1,
      record_type: "oracle_result",
      evidence_refs: [
        {
          artifact_path: "primary/journals/provider.jsonl",
          artifact_sha256: sha256Hex(event.get("primary/journals/provider.jsonl") as Uint8Array),
          event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      ],
    });
    const missingEvent = verify(event);
    assert.equal(missingEvent.package_ineligibility_reasons.includes("missing_event"), true);
    const conflict = buildEligibleValidation();
    putCanonical(conflict, "derived/attempt-projection.json", {
      evidence_refs: [
        {
          artifact_path: "primary/ledger/snapshot.json",
          artifact_sha256: sha256Hex(new Uint8Array([1, 2, 3])),
        },
      ],
    });
    const conflictResult = verify(conflict);
    assert.equal(conflictResult.package_ineligibility_reasons.includes("conflicting_reference"), true);
    assert.equal(conflictResult.package_ineligibility_reasons.includes("unresolved_reference"), true);
  });

  it("rejects malformed and misaligned checkpoints", () => {
    const malformed = buildEligibleProbe();
    requireOk(putUtf8(malformed, CHECKPOINT_PATH, "{"), "bad-checkpoint");
    const malformedResult = verify(malformed);
    assert.equal(malformedResult.package_ineligibility_reasons.includes("malformed_checkpoint"), true);
    const mismatch = buildEligibleProbe();
    requireOk(putUtf8(mismatch, JOURNAL_PATH, '{"event_id":"11111111-1111-4111-8111-111111111111","source_sequence":9}\n'), "journal");
    const mismatchResult = verify(mismatch);
    assert.equal(
      mismatchResult.package_ineligibility_reasons.includes("checkpoint_prefix_mismatch") ||
        mismatchResult.package_ineligibility_reasons.includes("malformed_checkpoint"),
      true,
    );
  });

  it("rejects invalid verify requests and store paths", () => {
    assert.equal(verifyOriginalPackage({}, { selected_amendment_head_sha256: null, now }).ok, false);
    assert.equal(verifyOriginalPackage(createPackageStore(), null).ok, false);
    assert.equal(
      verifyOriginalPackage(createPackageStore(), { selected_amendment_head_sha256: null, now: () => "nope" }).ok,
      false,
    );
    const store = createPackageStore();
    store.set("../x", new Uint8Array([1]));
    const result = verify(store);
    assert.equal(result.package_ineligibility_reasons.includes("invalid_path"), true);
  });

  it("round-trips a package directory and rejects unsafe entries", () => {
    const store = buildEligibleProbe();
    const root = mkdtempSync(join(tmpdir(), "pkg-"));
    assert.equal(savePackageDir(store, root).ok, true);
    const loaded = requireOk(loadPackageDir(root), "load");
    assert.equal(verify(loaded).package_eligibility, "eligible");
    assert.equal(savePackageDir({} as Map<string, Uint8Array>, root).ok, false);
    const fileRoot = join(root, "not-a-dir");
    writeFileSync(fileRoot, "x");
    assert.equal(loadPackageDir(fileRoot).ok, false);
    const linked = join(root, "link.json");
    symlinkSync(fileRoot, linked);
    const withLink = join(root, "with-link");
    mkdirSync(withLink);
    symlinkSync(fileRoot, join(withLink, "link.json"));
    assert.equal(loadPackageDir(withLink).ok, false);
    const badStore = createPackageStore();
    badStore.set("../x", new Uint8Array([1]));
    assert.equal(savePackageDir(badStore, root).ok, false);
    assert.equal(putUtf8(store, "../x", "no").ok, false);
  });

  it("creates and rejects prefix checkpoints with exact reasons", () => {
    const okCheckpoint = createPrefixCheckpoint({
      schema_version: 1,
      record_type: "coordination_prefix_checkpoint",
      path: JOURNAL_PATH,
      prefix_byte_count: 1,
      prefix_digest: sha256Hex("a"),
      last_included_event_id: EVENT_ONE,
      last_included_sequence: 1,
      checkpoint_time: NOW,
    });
    assert.equal(okCheckpoint.ok, true);
    assert.equal(createPrefixCheckpoint(null).ok, false);
    const rejected = createPrefixCheckpoint({
      schema_version: 2,
      record_type: "nope",
      path: "other.json",
      prefix_byte_count: 0,
      prefix_digest: "nope",
      last_included_event_id: "nope",
      last_included_sequence: 0,
      checkpoint_time: "nope",
      extra: true,
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.reasons.includes("unknown_property"), true);
      assert.equal(rejected.reasons.includes("invalid_schema_version"), true);
      assert.equal(rejected.reasons.includes("invalid_record_type"), true);
      assert.equal(rejected.reasons.includes("invalid_path"), true);
      assert.equal(rejected.reasons.includes("invalid_byte_count"), true);
      assert.equal(rejected.reasons.includes("invalid_sha256"), true);
      assert.equal(rejected.reasons.includes("invalid_uuid"), true);
      assert.equal(rejected.reasons.includes("invalid_sequence"), true);
      assert.equal(rejected.reasons.includes("invalid_timestamp"), true);
    }
  });

  it("resolves JSON pointers including escapes and array indexes", () => {
    const document = { "a/b": { "~": [ { k: true } ] } };
    assert.equal(jsonPointerExists(document, ""), true);
    assert.equal(jsonPointerExists(document, "/a~1b/~0/0/k"), true);
    assert.equal(jsonPointerExists(document, "/a~1b/~0/00/k"), false);
    assert.equal(jsonPointerExists(document, "/a~1b/~0/1/k"), false);
    assert.equal(jsonPointerExists(document, "/missing"), false);
    assert.equal(jsonPointerExists(document, "relative"), false);
    assert.equal(jsonPointerExists([1], "/0"), true);
    assert.equal(jsonPointerExists([1], "/-"), false);
  });

  it("parses index records and rejects malformed indexes", () => {
    assert.equal(parseEvidenceIndex(null).ok, false);
    assert.equal(parsePackageIndex(null).ok, false);
    assert.equal(parseEvidenceIndex({ schema_version: 1, record_type: "evidence_index", entries: "no" }).ok, false);
    assert.equal(
      parseEvidenceIndex({
        schema_version: 2,
        record_type: "nope",
        entries: [{ extra: true }],
        extra: true,
      }).ok,
      false,
    );
    assert.equal(
      parsePackageIndex({
        schema_version: 2,
        record_type: "nope",
        entries: "no",
        extra: true,
      }).ok,
      false,
    );
    const duplicate = parseEvidenceIndex({
      schema_version: 1,
      record_type: "evidence_index",
      entries: [
        {
          artifact_path: "a.json",
          artifact_sha256: sha256Hex(""),
          byte_count: 0,
          classification: "primary",
        },
        {
          artifact_path: "a.json",
          artifact_sha256: sha256Hex(""),
          byte_count: 0,
          classification: "primary",
        },
      ],
    });
    assert.equal(duplicate.ok, false);
  });
});
