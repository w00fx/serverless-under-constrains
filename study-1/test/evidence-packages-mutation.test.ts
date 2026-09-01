import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sha256Hex } from "../src/protocol-records/index.ts";
import {
  CHECKPOINT_PATH,
  EVIDENCE_INDEX_PATH,
  JOURNAL_PATH,
  LATE_EVIDENCE_AREA,
  PACKAGE_INDEX_PATH,
  createPackageStore,
  createPrefixCheckpoint,
  loadPackageDir,
  putUtf8,
  savePackageDir,
  validateCheckpointAgainstJournal,
  verifyOriginalPackage,
  writeEvidenceIndex,
  writePackageIndex,
} from "../src/evidence-packages/index.ts";
import { lastJournalEvent, readCheckpoint } from "../src/evidence-packages/checkpoint.ts";
import { parseEvidenceIndex, parsePackageIndex, writeIndexFile } from "../src/evidence-packages/entries.ts";
import { comparePaths } from "../src/evidence-packages/paths.ts";
import { jsonPointerExists, eventIdsIn } from "../src/evidence-packages/references.ts";
import { decodeUtf8 } from "../src/evidence-packages/utf8.ts";
import type { ValidationResult } from "../src/evidence-packages/result.ts";
import {
  EVENT_ONE,
  EVENT_TWO,
  NOW,
  buildEligibleProbe,
  putCanonical,
  requireOk,
} from "./fixtures/evidence-packages/build.ts";

const DIGEST = sha256Hex("");
const now = (): string => NOW;

function assertRejected(result: ValidationResult<unknown>, ...expected: string[]): void {
  assert.equal(result.ok, false, expected.join(","));
  if (result.ok) {
    return;
  }
  assert.deepEqual([...result.reasons].toSorted(), [...expected].toSorted());
}

function verify(store: Map<string, Uint8Array>, head: unknown = null) {
  return requireOk(verifyOriginalPackage(store, { selected_amendment_head_sha256: head, now }), "verify");
}

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    artifact_path: "a.json",
    artifact_sha256: DIGEST,
    byte_count: 0,
    ...overrides,
  };
}

function validEvidenceEntry(overrides: Record<string, unknown> = {}) {
  return { ...validEntry(), classification: "primary", ...overrides };
}

function packageIndex(entries: unknown[], overrides: Record<string, unknown> = {}) {
  return { schema_version: 1, record_type: "package_index", entries, ...overrides };
}

function evidenceIndex(entries: unknown[], overrides: Record<string, unknown> = {}) {
  return { schema_version: 1, record_type: "evidence_index", entries, ...overrides };
}

function validCheckpointInput(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    record_type: "coordination_prefix_checkpoint",
    path: JOURNAL_PATH,
    prefix_byte_count: 1,
    prefix_digest: sha256Hex("x"),
    last_included_event_id: EVENT_ONE,
    last_included_sequence: 1,
    checkpoint_time: NOW,
    ...overrides,
  };
}

function checkpointOf(overrides: Record<string, unknown> = {}) {
  return requireOk(createPrefixCheckpoint(validCheckpointInput(overrides)), "checkpoint");
}

function lineFor(eventId: string, sequence: number): string {
  return `{"event_id":"${eventId}","source_sequence":${String(sequence)}}\n`;
}

describe("evidence-packages mutation hardening", () => {
  it("rejects each index envelope fault with the exact reason", () => {
    assertRejected(parsePackageIndex(null), "not_an_object");
    assertRejected(parseEvidenceIndex(undefined), "not_an_object");
    assertRejected(parsePackageIndex(packageIndex([], { extra: true })), "unknown_property");
    assertRejected(parseEvidenceIndex(evidenceIndex([], { extra: true })), "unknown_property");
    assertRejected(parsePackageIndex(packageIndex([], { schema_version: 2 })), "invalid_schema_version");
    assertRejected(parseEvidenceIndex(evidenceIndex([], { schema_version: 2 })), "invalid_schema_version");
    assertRejected(parsePackageIndex(packageIndex([], { record_type: "nope" })), "invalid_record_type");
    assertRejected(parseEvidenceIndex(evidenceIndex([], { record_type: "nope" })), "invalid_record_type");
    assertRejected(parsePackageIndex(packageIndex(1 as unknown as unknown[])), "not_an_object");
    assertRejected(parseEvidenceIndex(evidenceIndex(true as unknown as unknown[])), "not_an_object");
  });

  it("accepts empty indexes and rejects each entry field in isolation", () => {
    const emptyPackage = parsePackageIndex(packageIndex([]));
    assert.equal(emptyPackage.ok, true);
    if (emptyPackage.ok) {
      assert.deepEqual(emptyPackage.value.entries, []);
      assert.equal(emptyPackage.value.record_type, "package_index");
      assert.equal(emptyPackage.value.schema_version, 1);
    }
    const emptyEvidence = parseEvidenceIndex(evidenceIndex([]));
    assert.equal(emptyEvidence.ok, true);
    if (emptyEvidence.ok) {
      assert.deepEqual(emptyEvidence.value.entries, []);
      assert.equal(emptyEvidence.value.record_type, "evidence_index");
    }
    const okZero = parsePackageIndex(packageIndex([validEntry({ byte_count: 0 })]));
    assert.equal(okZero.ok, true);
    assertRejected(parsePackageIndex(packageIndex([null])), "not_an_object");
    assertRejected(parseEvidenceIndex(evidenceIndex([null])), "not_an_object");
    assertRejected(parsePackageIndex(packageIndex([validEntry({ extra: true })])), "unknown_property");
    assertRejected(parseEvidenceIndex(evidenceIndex([validEvidenceEntry({ extra: true })])), "unknown_property");
    assertRejected(parsePackageIndex(packageIndex([validEntry({ artifact_path: "../x" })])), "invalid_path");
    assertRejected(parseEvidenceIndex(evidenceIndex([validEvidenceEntry({ artifact_path: "../x" })])), "invalid_path");
    assertRejected(parsePackageIndex(packageIndex([validEntry({ artifact_sha256: "nope" })])), "invalid_sha256");
    assertRejected(parseEvidenceIndex(evidenceIndex([validEvidenceEntry({ artifact_sha256: "nope" })])), "invalid_sha256");
    assertRejected(parsePackageIndex(packageIndex([validEntry({ byte_count: -1 })])), "invalid_byte_count");
    assertRejected(parsePackageIndex(packageIndex([validEntry({ byte_count: 1.5 })])), "invalid_byte_count");
    assertRejected(parsePackageIndex(packageIndex([validEntry({ byte_count: true })])), "invalid_byte_count");
    assertRejected(parseEvidenceIndex(evidenceIndex([validEvidenceEntry({ byte_count: -1 })])), "invalid_byte_count");
    assertRejected(parseEvidenceIndex(evidenceIndex([validEvidenceEntry({ classification: "other" })])), "invalid_classification");
    assertRejected(
      parsePackageIndex(packageIndex([validEntry(), validEntry()])),
      "duplicate_index_entry",
    );
    assertRejected(
      parseEvidenceIndex(evidenceIndex([validEvidenceEntry(), validEvidenceEntry()])),
      "duplicate_index_entry",
    );
  });

  it("sorts parsed index entries and keeps comparePaths signs distinct", () => {
    const parsed = parsePackageIndex(
      packageIndex([validEntry({ artifact_path: "b.json" }), validEntry({ artifact_path: "a.json" })]),
    );
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.deepEqual(
        parsed.value.entries.map((entry) => entry.artifact_path),
        ["a.json", "b.json"],
      );
    }
    assert.equal(comparePaths("a", "a"), 0);
    assert.equal(comparePaths("a", "b"), -1);
    assert.equal(comparePaths("b", "a"), 1);
    assert.equal(comparePaths("a", "a") === comparePaths("a", "b"), false);
  });

  it("rejects each prefix-checkpoint field in isolation", () => {
    assertRejected(createPrefixCheckpoint(null), "not_an_object");
    assertRejected(createPrefixCheckpoint(validCheckpointInput({ extra: true })), "unknown_property");
    assertRejected(createPrefixCheckpoint(validCheckpointInput({ schema_version: 2 })), "invalid_schema_version");
    assertRejected(createPrefixCheckpoint(validCheckpointInput({ record_type: "nope" })), "invalid_record_type");
    assertRejected(createPrefixCheckpoint(validCheckpointInput({ path: "other.json" })), "invalid_path");
    assertRejected(createPrefixCheckpoint(validCheckpointInput({ prefix_byte_count: 0 })), "invalid_byte_count");
    assertRejected(createPrefixCheckpoint(validCheckpointInput({ prefix_digest: "nope" })), "invalid_sha256");
    assertRejected(createPrefixCheckpoint(validCheckpointInput({ last_included_event_id: "nope" })), "invalid_uuid");
    assertRejected(createPrefixCheckpoint(validCheckpointInput({ last_included_sequence: 0 })), "invalid_sequence");
    assertRejected(createPrefixCheckpoint(validCheckpointInput({ checkpoint_time: "nope" })), "invalid_timestamp");
  });

  it("aligns a full-journal prefix and rejects over-length and newline faults", () => {
    const first = lineFor(EVENT_ONE, 1);
    const journal = new TextEncoder().encode(first + lineFor(EVENT_TWO, 2));
    const full = checkpointOf({
      prefix_byte_count: journal.byteLength,
      prefix_digest: sha256Hex(journal),
      last_included_event_id: EVENT_TWO,
      last_included_sequence: 2,
    });
    assert.equal(validateCheckpointAgainstJournal(full, journal).ok, true);
    const over = checkpointOf({
      prefix_byte_count: journal.byteLength + 1,
      prefix_digest: sha256Hex(journal),
      last_included_event_id: EVENT_TWO,
      last_included_sequence: 2,
    });
    assertRejected(validateCheckpointAgainstJournal(over, journal), "checkpoint_prefix_mismatch");
    const extra = `${first.slice(0, -1)}X`;
    const noNewline = checkpointOf({
      prefix_byte_count: extra.length,
      prefix_digest: sha256Hex(extra),
    });
    assertRejected(
      validateCheckpointAgainstJournal(noNewline, new TextEncoder().encode(`${extra}more`)),
      "malformed_checkpoint",
    );
    const invalidUtf8 = new Uint8Array([0xff, 0x0a]);
    const utf8Checkpoint = checkpointOf({
      prefix_byte_count: invalidUtf8.byteLength,
      prefix_digest: sha256Hex(invalidUtf8),
    });
    assertRejected(validateCheckpointAgainstJournal(utf8Checkpoint, invalidUtf8), "malformed_checkpoint");
    const emptyLine = checkpointOf({
      prefix_byte_count: 1,
      prefix_digest: sha256Hex("\n"),
    });
    assertRejected(validateCheckpointAgainstJournal(emptyLine, new TextEncoder().encode("\nmore")), "malformed_checkpoint");
    const badJson = checkpointOf({
      prefix_byte_count: 5,
      prefix_digest: sha256Hex("nope\n"),
    });
    assertRejected(validateCheckpointAgainstJournal(badJson, new TextEncoder().encode("nope\n")), "malformed_checkpoint");
    const digest = checkpointOf({
      prefix_byte_count: journal.byteLength,
      prefix_digest: sha256Hex("other"),
      last_included_event_id: EVENT_TWO,
      last_included_sequence: 2,
    });
    assertRejected(validateCheckpointAgainstJournal(digest, journal), "checkpoint_prefix_mismatch");
    const noEvent = checkpointOf({
      prefix_byte_count: 3,
      prefix_digest: sha256Hex("{}\n"),
    });
    assertRejected(validateCheckpointAgainstJournal(noEvent, new TextEncoder().encode("{}\n")), "checkpoint_prefix_mismatch");
    const wrongId = checkpointOf({
      prefix_byte_count: first.length,
      prefix_digest: sha256Hex(first),
      last_included_event_id: EVENT_TWO,
    });
    assertRejected(
      validateCheckpointAgainstJournal(wrongId, new TextEncoder().encode(first + lineFor(EVENT_TWO, 2))),
      "checkpoint_prefix_mismatch",
    );
    const wrongSeq = checkpointOf({
      prefix_byte_count: first.length,
      prefix_digest: sha256Hex(first),
      last_included_sequence: 9,
    });
    assertRejected(
      validateCheckpointAgainstJournal(wrongSeq, new TextEncoder().encode(first + lineFor(EVENT_TWO, 2))),
      "checkpoint_prefix_mismatch",
    );
    assertRejected(readCheckpoint(new Uint8Array([0xff])), "malformed_checkpoint");
    assertRejected(readCheckpoint(new TextEncoder().encode("{")), "malformed_checkpoint");
    assert.equal(lastJournalEvent([]), undefined);
    assert.equal(decodeUtf8(new Uint8Array([0xff])), undefined);
    assert.equal(decodeUtf8(new TextEncoder().encode("ok")), "ok");
  });

  it("rejects store writes and loads with exact reasons", () => {
    const store = createPackageStore();
    assertRejected(putUtf8(store, "../x", "no"), "invalid_path");
    const root = mkdtempSync(join(tmpdir(), "pkg-mh-"));
    putCanonical(store, "primary/execution-manifest.json", { artifact: "manifest" });
    const saved = savePackageDir(store, root);
    assert.equal(saved.ok, true);
    if (saved.ok) {
      assert.equal(saved.value, true);
    }
    assertRejected(savePackageDir({} as Map<string, Uint8Array>, root), "not_an_object");
    const bad = createPackageStore();
    bad.set("../x", new Uint8Array([1]));
    assertRejected(savePackageDir(bad, root), "invalid_path");
    const mixed = createPackageStore();
    putCanonical(mixed, "ok.json", { ok: true });
    mixed.set("odd.json", "nope" as unknown as Uint8Array);
    assertRejected(savePackageDir(mixed, root), "invalid_path");
    const fileRoot = join(root, "not-a-dir");
    writeFileSync(fileRoot, "x");
    assertRejected(loadPackageDir(fileRoot), "invalid_path");
    const linkedDir = mkdtempSync(join(tmpdir(), "pkg-mh-dir-"));
    writeFileSync(join(linkedDir, "inside.json"), "{}");
    const withDirLink = mkdtempSync(join(tmpdir(), "pkg-mh-dirlink-"));
    symlinkSync(linkedDir, join(withDirLink, "nested"));
    assertRejected(loadPackageDir(withDirLink), "invalid_path");
    const slashDir = mkdtempSync(join(tmpdir(), "pkg-mh-slash-"));
    writeFileSync(join(slashDir, "foo\\bar"), "x");
    assertRejected(loadPackageDir(slashDir), "invalid_path");
  });

  it("refuses rewrite when only one index is present and requires primary reserved paths", () => {
    const onlyPackage = createPackageStore();
    putCanonical(onlyPackage, PACKAGE_INDEX_PATH, { marker: true });
    putCanonical(onlyPackage, "primary/execution-manifest.json", { artifact: "manifest" });
    assertRejected(writeEvidenceIndex(onlyPackage, { "primary/execution-manifest.json": "primary" }), "rewrite_forbidden");
    const onlyEvidence = createPackageStore();
    putCanonical(onlyEvidence, EVIDENCE_INDEX_PATH, { marker: true });
    putCanonical(onlyEvidence, "primary/execution-manifest.json", { artifact: "manifest" });
    assertRejected(writeEvidenceIndex(onlyEvidence, { "primary/execution-manifest.json": "primary" }), "rewrite_forbidden");
    const journal = createPackageStore();
    putCanonical(journal, "primary/execution-manifest.json", { artifact: "manifest" });
    requireOk(putUtf8(journal, JOURNAL_PATH, lineFor(EVENT_ONE, 1)), "journal");
    const prefix = new TextEncoder().encode(lineFor(EVENT_ONE, 1));
    putCanonical(
      journal,
      CHECKPOINT_PATH,
      checkpointOf({ prefix_byte_count: prefix.byteLength, prefix_digest: sha256Hex(prefix) }),
    );
    assertRejected(
      writeEvidenceIndex(journal, {
        "primary/execution-manifest.json": "primary",
        [CHECKPOINT_PATH]: "derived",
      }),
      "invalid_classification",
    );
    const area = createPackageStore();
    putCanonical(area, "primary/execution-manifest.json", { artifact: "manifest" });
    putCanonical(area, LATE_EVIDENCE_AREA, { late: true });
    requireOk(writeEvidenceIndex(area, { "primary/execution-manifest.json": "primary" }), "late-area");
    const classifiedArea = createPackageStore();
    putCanonical(classifiedArea, "primary/execution-manifest.json", { artifact: "manifest" });
    putCanonical(classifiedArea, LATE_EVIDENCE_AREA, { late: true });
    assertRejected(
      writeEvidenceIndex(classifiedArea, {
        "primary/execution-manifest.json": "primary",
        [LATE_EVIDENCE_AREA]: "primary",
      }),
      "invalid_classification",
    );
  });

  it("does not write an index file when serialization fails", () => {
    const store = createPackageStore();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assertRejected(writeIndexFile(store, "x.json", cyclic), "unserializable_value");
    assert.equal(store.has("x.json"), false);
  });

  it("reports missing indexes without treating them as malformed objects", () => {
    const missing = verify(createPackageStore());
    assert.equal(missing.package_eligibility, "ineligible");
    assert.equal(missing.record_type, "package_verification");
    assert.equal(missing.schema_version, 1);
    assert.equal(missing.package_ineligibility_reasons.includes("missing_file"), true);
    assert.equal(missing.package_ineligibility_reasons.includes("missing_evidence_index"), true);
    assert.equal(missing.package_ineligibility_reasons.includes("not_an_object"), false);
    assertRejected(verifyOriginalPackage({}, { selected_amendment_head_sha256: null, now }), "not_an_object");
    assertRejected(verifyOriginalPackage(createPackageStore(), null), "not_an_object");
    assertRejected(
      verifyOriginalPackage(createPackageStore(), { selected_amendment_head_sha256: null, now: "nope" }),
      "not_an_object",
    );
    assertRejected(
      verifyOriginalPackage(createPackageStore(), { selected_amendment_head_sha256: null, now: () => "nope" }),
      "invalid_timestamp",
    );
    const odd = createPackageStore();
    odd.set("derived/odd.json", "nope" as unknown as Uint8Array);
    const oddResult = verify(odd);
    assert.equal(oddResult.package_ineligibility_reasons.includes("invalid_path"), true);
    const nonBytes = createPackageStore();
    putCanonical(nonBytes, "primary/execution-manifest.json", { artifact: "manifest" });
    nonBytes.set("primary/odd.json", "nope" as unknown as Uint8Array);
    assertRejected(
      writeEvidenceIndex(nonBytes, {
        "primary/execution-manifest.json": "primary",
        "primary/odd.json": "primary",
      }),
      "invalid_path",
      "missing_file",
    );
  });

  it("keeps matching package-index digests and repeated identical refs eligible for those checks", () => {
    const matching = buildEligibleProbe();
    const digest = sha256Hex(matching.get(PACKAGE_INDEX_PATH) ?? new Uint8Array());
    const target = matching.get("primary/execution-manifest.json");
    assert.notEqual(target, undefined);
    putCanonical(matching, "derived/extra-refs.json", {
      evidence_refs: [
        {
          artifact_path: "primary/execution-manifest.json",
          artifact_sha256: sha256Hex(target as Uint8Array),
          package_index_sha256: digest,
        },
      ],
    });
    putCanonical(matching, "derived/more-refs.json", {
      evidence_refs: [
        {
          artifact_path: "primary/execution-manifest.json",
          artifact_sha256: sha256Hex(target as Uint8Array),
        },
      ],
    });
    const result = verify(matching);
    assert.equal(result.package_ineligibility_reasons.includes("unresolved_reference"), false);
    assert.equal(result.package_ineligibility_reasons.includes("conflicting_reference"), false);
    assert.equal(result.package_ineligibility_reasons.includes("package_index_incomplete"), true);
  });

  it("resolves JSON pointers at array bounds and rejects relative tokens that exist as keys", () => {
    const long = Array.from({ length: 101 }, (_, index) => index);
    assert.equal(jsonPointerExists(long, "/100"), true);
    assert.equal(jsonPointerExists(long, "/101"), false);
    assert.equal(jsonPointerExists(long, "/10"), true);
    assert.equal(jsonPointerExists([1], "/1"), false);
    assert.equal(jsonPointerExists([1], "/0"), true);
    assert.equal(jsonPointerExists({ relative: true }, "relative"), false);
    assert.equal(jsonPointerExists({ relative: true }, "/relative"), true);
    const nestedIds = eventIdsIn(new TextEncoder().encode('{"event_id":1,"nested":{"event_id":"x"}}'));
    assert.equal(nestedIds.has("x"), true);
    assert.equal(nestedIds.size, 1);
    assert.equal(jsonPointerExists({ elative: true }, "relative"), false);
    const otherIds = eventIdsIn(new TextEncoder().encode('{"other":"not-an-id","event_id":"x"}'));
    assert.equal(otherIds.has("x"), true);
    assert.equal(otherIds.has("not-an-id"), false);
    assert.equal(otherIds.size, 1);
    assert.equal(eventIdsIn(new TextEncoder().encode('{"k":"v"}')).size, 0);
  });

  it("rejects writer and verifier faults with exact isolated reasons", () => {
    assertRejected(writeEvidenceIndex({}, {}), "not_an_object");
    assertRejected(writePackageIndex({}), "not_an_object");
    const missingEvidence = createPackageStore();
    putCanonical(missingEvidence, "primary/execution-manifest.json", { artifact: "manifest" });
    requireOk(writeEvidenceIndex(missingEvidence, { "primary/execution-manifest.json": "primary" }), "ei");
    missingEvidence.set("../x", new Uint8Array([1]));
    assertRejected(writePackageIndex(missingEvidence), "invalid_path");
    const oddPackage = createPackageStore();
    putCanonical(oddPackage, "primary/execution-manifest.json", { artifact: "manifest" });
    requireOk(writeEvidenceIndex(oddPackage, { "primary/execution-manifest.json": "primary" }), "ei2");
    oddPackage.set("primary/odd.json", "nope" as unknown as Uint8Array);
    assertRejected(writePackageIndex(oddPackage), "invalid_path");
    const dangling = buildEligibleProbe();
    dangling.set(
      "../x",
      new TextEncoder().encode(
        JSON.stringify({
          evidence_refs: [{ artifact_path: "primary/missing.json", artifact_sha256: DIGEST }],
        }),
      ),
    );
    const danglingResult = verify(dangling);
    assert.equal(danglingResult.package_ineligibility_reasons.includes("invalid_path"), true);
    assert.equal(danglingResult.package_ineligibility_reasons.includes("unresolved_reference"), false);
    assert.equal(danglingResult.package_ineligibility_reasons.includes("package_index_incomplete"), false);
    const malformedEvidence = buildEligibleProbe();
    requireOk(putUtf8(malformedEvidence, EVIDENCE_INDEX_PATH, "{\"schema_version\":1}"), "bad-ei");
    const malformed = verify(malformedEvidence);
    assert.equal(malformed.package_ineligibility_reasons.includes("invalid_record_type"), true);
    assert.equal(malformed.package_ineligibility_reasons.includes("missing_evidence_index"), false);
    const missingListed = buildEligibleProbe();
    const pack = requireOk(
      parsePackageIndex(JSON.parse(new TextDecoder().decode(missingListed.get(PACKAGE_INDEX_PATH)))),
      "pi",
    );
    pack.entries.push({ artifact_path: "primary/gone.json", artifact_sha256: DIGEST, byte_count: 0 });
    putCanonical(missingListed, PACKAGE_INDEX_PATH, pack);
    assert.equal(verify(missingListed).package_ineligibility_reasons.includes("missing_file"), true);
  });

  it("isolates evidence-index digest, byte-count, and checkpoint classification faults", () => {
    function rewriteEvidence(
      store: Map<string, Uint8Array>,
      mutate: (entries: { artifact_path: string; artifact_sha256: string; byte_count: number; classification: string }[]) => void,
    ): void {
      const evidence = requireOk(
        parseEvidenceIndex(JSON.parse(new TextDecoder().decode(store.get(EVIDENCE_INDEX_PATH)))),
        "ei",
      );
      mutate(evidence.entries);
      putCanonical(store, EVIDENCE_INDEX_PATH, evidence);
      const pack = requireOk(
        parsePackageIndex(JSON.parse(new TextDecoder().decode(store.get(PACKAGE_INDEX_PATH)))),
        "pi",
      );
      const bytes = store.get(EVIDENCE_INDEX_PATH);
      assert.notEqual(bytes, undefined);
      const listed = pack.entries.find((entry) => entry.artifact_path === EVIDENCE_INDEX_PATH);
      assert.notEqual(listed, undefined);
      if (listed !== undefined && bytes !== undefined) {
        listed.artifact_sha256 = sha256Hex(bytes);
        listed.byte_count = bytes.byteLength;
      }
      putCanonical(store, PACKAGE_INDEX_PATH, pack);
    }
    const digestStore = buildEligibleProbe();
    rewriteEvidence(digestStore, (entries) => {
      const first = entries[0];
      assert.notEqual(first, undefined);
      if (first !== undefined) {
        first.artifact_sha256 = sha256Hex("mutated");
      }
    });
    assert.equal(verify(digestStore).package_ineligibility_reasons.includes("digest_mismatch"), true);
    const counted = buildEligibleProbe();
    rewriteEvidence(counted, (entries) => {
      const first = entries[0];
      assert.notEqual(first, undefined);
      if (first !== undefined) {
        first.byte_count = first.byte_count + 1;
      }
    });
    assert.equal(verify(counted).package_ineligibility_reasons.includes("byte_count_mismatch"), true);
    const derived = buildEligibleProbe();
    rewriteEvidence(derived, (entries) => {
      const checkpoint = entries.find((entry) => entry.artifact_path === CHECKPOINT_PATH);
      assert.notEqual(checkpoint, undefined);
      if (checkpoint !== undefined) {
        checkpoint.classification = "derived";
      }
    });
    assert.equal(verify(derived).package_ineligibility_reasons.includes("invalid_classification"), true);
  });
});
