import assert from "node:assert/strict";
import { execSync } from "node:child_process";
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
  validateCheckpointAgainstJournal,
  verifyOriginalPackage,
  writeEvidenceIndex,
  writePackageIndex,
} from "../src/evidence-packages/index.ts";
import { lastJournalEvent, readCheckpoint } from "../src/evidence-packages/checkpoint.ts";
import { comparePaths } from "../src/evidence-packages/paths.ts";
import { parseEvidenceIndex, parsePackageIndex, writeIndexFile } from "../src/evidence-packages/entries.ts";
import { eventIdsIn } from "../src/evidence-packages/references.ts";
import { decodeUtf8 } from "../src/evidence-packages/utf8.ts";
import {
  EVENT_ONE,
  EVENT_TWO,
  NOW,
  buildEligibleProbe,
  putCanonical,
  requireOk,
} from "./fixtures/evidence-packages/build.ts";

const now = (): string => NOW;

function verify(store: Map<string, Uint8Array>) {
  return requireOk(verifyOriginalPackage(store, { selected_amendment_head_sha256: null, now }), "verify");
}

function validCheckpoint(overrides: Record<string, unknown> = {}) {
  return requireOk(
    createPrefixCheckpoint({
      schema_version: 1,
      record_type: "coordination_prefix_checkpoint",
      path: JOURNAL_PATH,
      prefix_byte_count: 1,
      prefix_digest: sha256Hex("x"),
      last_included_event_id: EVENT_ONE,
      last_included_sequence: 1,
      checkpoint_time: NOW,
      ...overrides,
    }),
    "checkpoint",
  );
}

describe("evidence-package coverage seams", () => {
  it("covers checkpoint alignment failures", () => {
    const line = `{"event_id":"${EVENT_ONE}","source_sequence":1}\n`;
    const journal = new TextEncoder().encode(line + `{"event_id":"${EVENT_TWO}","source_sequence":2}\n`);
    const prefix = new TextEncoder().encode(line);
    const checkpoint = validCheckpoint({
      prefix_byte_count: prefix.byteLength,
      prefix_digest: sha256Hex(prefix),
    });
    assert.equal(validateCheckpointAgainstJournal(checkpoint, new Uint8Array([1])).ok, false);
    assert.equal(
      validateCheckpointAgainstJournal({ ...checkpoint, prefix_digest: sha256Hex("other") }, journal).ok,
      false,
    );
    const noNewline = validCheckpoint({
      prefix_byte_count: 2,
      prefix_digest: sha256Hex(new Uint8Array([123, 125])),
    });
    assert.equal(validateCheckpointAgainstJournal(noNewline, new Uint8Array([123, 125, 10])).ok, false);
    const emptyLine = validCheckpoint({
      prefix_byte_count: 1,
      prefix_digest: sha256Hex("\n"),
    });
    assert.equal(validateCheckpointAgainstJournal(emptyLine, new TextEncoder().encode("\nmore")).ok, false);
    const badJson = validCheckpoint({
      prefix_byte_count: 5,
      prefix_digest: sha256Hex("nope\n"),
    });
    assert.equal(validateCheckpointAgainstJournal(badJson, new TextEncoder().encode("nope\n")).ok, false);
    const noEvent = validCheckpoint({
      prefix_byte_count: 3,
      prefix_digest: sha256Hex("{}\n"),
    });
    assert.equal(validateCheckpointAgainstJournal(noEvent, new TextEncoder().encode("{}\n")).ok, false);
    const wrongId = validCheckpoint({
      prefix_byte_count: prefix.byteLength,
      prefix_digest: sha256Hex(prefix),
      last_included_event_id: EVENT_TWO,
    });
    assert.equal(validateCheckpointAgainstJournal(wrongId, journal).ok, false);
    const wrongSeq = validCheckpoint({
      prefix_byte_count: prefix.byteLength,
      prefix_digest: sha256Hex(prefix),
      last_included_sequence: 9,
    });
    assert.equal(validateCheckpointAgainstJournal(wrongSeq, journal).ok, false);
    assert.equal(lastJournalEvent([]), undefined);
    assert.equal(lastJournalEvent([{ event_id: EVENT_ONE }]), undefined);
    assert.equal(readCheckpoint(new Uint8Array([0xff])).ok, false);
    assert.equal(decodeUtf8(new Uint8Array([0xff])), undefined);
    assert.equal(eventIdsIn(new Uint8Array([0xff])).size, 0);
    assert.equal(eventIdsIn(new TextEncoder().encode("not-json\n\n{\"event_id\":\"x\"}\n")).has("x"), true);
    assert.equal(eventIdsIn(new TextEncoder().encode("not-json\n{\"event_id\":\"y\"}")).has("y"), true);
    assert.equal(comparePaths("a", "a"), 0);
    assert.equal(comparePaths("a", "b") < 0, true);
    assert.equal(comparePaths("b", "a") > 0, true);
  });

  it("covers writer classification, alignment, and package-index path faults", () => {
    const store = createPackageStore();
    putCanonical(store, "primary/execution-manifest.json", { artifact: "manifest" });
    requireOk(
      putUtf8(store, JOURNAL_PATH, `{"event_id":"${EVENT_ONE}","source_sequence":1}\n`),
      "journal",
    );
    const derivedJournal = writeEvidenceIndex(store, {
      "primary/execution-manifest.json": "primary",
      [JOURNAL_PATH]: "derived",
    });
    assert.equal(derivedJournal.ok, false);
    if (!derivedJournal.ok) {
      assert.equal(derivedJournal.reasons.includes("invalid_classification"), true);
    }
    const badClass = writeEvidenceIndex(store, {
      "primary/execution-manifest.json": "other",
      [JOURNAL_PATH]: "primary",
    });
    assert.equal(badClass.ok, false);
    const missingClass = writeEvidenceIndex(store, { [JOURNAL_PATH]: "primary" });
    assert.equal(missingClass.ok, false);
    const unknownFile = writeEvidenceIndex(store, {
      "primary/execution-manifest.json": "primary",
      [JOURNAL_PATH]: "primary",
      "primary/missing.json": "primary",
    });
    assert.equal(unknownFile.ok, false);
    if (!unknownFile.ok) {
      assert.equal(unknownFile.reasons.includes("missing_file"), true);
    }
    const reserved = writeEvidenceIndex(store, {
      "primary/execution-manifest.json": "primary",
      [JOURNAL_PATH]: "primary",
      [EVIDENCE_INDEX_PATH]: "derived",
    });
    assert.equal(reserved.ok, false);
    const prefix = new TextEncoder().encode(`{"event_id":"${EVENT_ONE}","source_sequence":1}\n`);
    putCanonical(
      store,
      CHECKPOINT_PATH,
      validCheckpoint({
        prefix_byte_count: prefix.byteLength,
        prefix_digest: sha256Hex(new TextEncoder().encode("wrong\n")),
      }),
    );
    const misaligned = writeEvidenceIndex(store, {
      "primary/execution-manifest.json": "primary",
      [CHECKPOINT_PATH]: "primary",
    });
    assert.equal(misaligned.ok, false);
    const derivedCheckpoint = writeEvidenceIndex(store, {
      "primary/execution-manifest.json": "primary",
      [CHECKPOINT_PATH]: "derived",
    });
    assert.equal(derivedCheckpoint.ok, false);
    const clean = createPackageStore();
    putCanonical(clean, "primary/execution-manifest.json", { artifact: "manifest" });
    requireOk(writeEvidenceIndex(clean, { "primary/execution-manifest.json": "primary" }), "ei");
    clean.set("../x", new Uint8Array([1]));
    const badPackagePath = writePackageIndex(clean);
    assert.equal(badPackagePath.ok, false);
    const nonBytes = createPackageStore();
    putCanonical(nonBytes, "primary/execution-manifest.json", { artifact: "manifest" });
    requireOk(writeEvidenceIndex(nonBytes, { "primary/execution-manifest.json": "primary" }), "ei2");
    nonBytes.set("primary/odd.json", "nope" as unknown as Uint8Array);
    const odd = writePackageIndex(nonBytes);
    assert.equal(odd.ok, false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(writeIndexFile(createPackageStore(), "x.json", cyclic).ok, false);
    const withJournal = createPackageStore();
    putCanonical(withJournal, "primary/execution-manifest.json", { artifact: "manifest" });
    requireOk(putUtf8(withJournal, JOURNAL_PATH, `{"event_id":"${EVENT_ONE}","source_sequence":1}\n`), "j");
    putCanonical(withJournal, CHECKPOINT_PATH, { not: "a checkpoint" });
    const malformed = writeEvidenceIndex(withJournal, {
      "primary/execution-manifest.json": "primary",
      [CHECKPOINT_PATH]: "primary",
    });
    assert.equal(malformed.ok, false);
    if (!malformed.ok) {
      assert.equal(malformed.reasons.includes("malformed_checkpoint"), true);
    }
  });

  it("covers verifier entry, index-parse, and reference seams", () => {
    const missingEntry = buildEligibleProbe();
    const evidence = requireOk(
      parseEvidenceIndex(JSON.parse(new TextDecoder().decode(missingEntry.get(EVIDENCE_INDEX_PATH)))),
      "ei",
    );
    evidence.entries.push({
      artifact_path: "primary/gone.json",
      artifact_sha256: sha256Hex("gone"),
      byte_count: 4,
      classification: "primary",
    });
    putCanonical(missingEntry, EVIDENCE_INDEX_PATH, evidence);
    assert.equal(verify(missingEntry).package_ineligibility_reasons.includes("missing_file"), true);
    const counted = buildEligibleProbe();
    const pack = requireOk(
      parsePackageIndex(JSON.parse(new TextDecoder().decode(counted.get(PACKAGE_INDEX_PATH)))),
      "pi",
    );
    const first = pack.entries[0];
    assert.notEqual(first, undefined);
    if (first !== undefined) {
      first.byte_count = first.byte_count + 1;
    }
    putCanonical(counted, PACKAGE_INDEX_PATH, pack);
    assert.equal(verify(counted).package_ineligibility_reasons.includes("byte_count_mismatch"), true);
    const journaled = buildEligibleProbe();
    const withJournal = requireOk(
      parseEvidenceIndex(JSON.parse(new TextDecoder().decode(journaled.get(EVIDENCE_INDEX_PATH)))),
      "ej",
    );
    const journal = journaled.get(JOURNAL_PATH);
    assert.notEqual(journal, undefined);
    withJournal.entries.push({
      artifact_path: JOURNAL_PATH,
      artifact_sha256: sha256Hex(journal as Uint8Array),
      byte_count: (journal as Uint8Array).byteLength,
      classification: "derived",
    });
    putCanonical(journaled, EVIDENCE_INDEX_PATH, withJournal);
    const journaledResult = verify(journaled);
    assert.equal(journaledResult.package_ineligibility_reasons.includes("evidence_index_incomplete"), true);
    assert.equal(journaledResult.package_ineligibility_reasons.includes("invalid_classification"), true);
    const noJournal = buildEligibleProbe();
    noJournal.delete(JOURNAL_PATH);
    assert.equal(verify(noJournal).package_ineligibility_reasons.includes("missing_file"), true);
    const badIndex = buildEligibleProbe();
    requireOk(putUtf8(badIndex, PACKAGE_INDEX_PATH, "{\"schema_version\":1}"), "bad-pi");
    requireOk(putUtf8(badIndex, EVIDENCE_INDEX_PATH, "{\"schema_version\":1}"), "bad-ei");
    const parsed = verify(badIndex);
    assert.equal(parsed.package_ineligibility_reasons.includes("invalid_record_type"), true);
    assert.equal(parsed.package_ineligibility_reasons.includes("missing_file"), false);
    const refs = buildEligibleProbe();
    putCanonical(refs, "derived/probe-summary.json", { evidence_refs: "nope" });
    assert.equal(verify(refs).package_ineligibility_reasons.includes("not_an_object"), true);
    const digest = sha256Hex(refs.get(PACKAGE_INDEX_PATH) ?? new Uint8Array());
    putCanonical(refs, "derived/probe-summary.json", {
      evidence_refs: [
        {
          artifact_path: "primary/execution-manifest.json",
          artifact_sha256: sha256Hex(refs.get("primary/execution-manifest.json") as Uint8Array),
          package_index_sha256: sha256Hex("other"),
        },
      ],
    });
    assert.equal(verify(refs).package_ineligibility_reasons.includes("unresolved_reference"), true);
    putCanonical(refs, "derived/probe-summary.json", {
      evidence_refs: [
        {
          artifact_path: JOURNAL_PATH,
          artifact_sha256: sha256Hex(refs.get(JOURNAL_PATH) as Uint8Array),
          json_pointer: "/event_id",
        },
      ],
    });
    assert.equal(verify(refs).package_ineligibility_reasons.includes("invalid_json_pointer"), true);
    const binary = buildEligibleProbe();
    binary.set("primary/assembly/inventory.json", new Uint8Array([0xff, 0xfe]));
    putCanonical(binary, "derived/probe-summary.json", {
      evidence_refs: [
        {
          artifact_path: "primary/assembly/inventory.json",
          artifact_sha256: sha256Hex(new Uint8Array([0xff, 0xfe])),
          json_pointer: "/a",
        },
      ],
    });
    assert.equal(verify(binary).package_ineligibility_reasons.includes("invalid_json_pointer"), true);
    assert.notEqual(digest, "");
    const invalidPath = buildEligibleProbe();
    invalidPath.set("../x", new Uint8Array([1]));
    invalidPath.set("derived/odd.json", "nope" as unknown as Uint8Array);
    assert.equal(verify(invalidPath).package_ineligibility_reasons.includes("invalid_path"), true);
    const unreadable = buildEligibleProbe();
    unreadable.set(PACKAGE_INDEX_PATH, new Uint8Array([0xff]));
    requireOk(putUtf8(unreadable, EVIDENCE_INDEX_PATH, "{"), "bad-json");
    const unreadableResult = verify(unreadable);
    assert.equal(unreadableResult.package_eligibility, "ineligible");
    const jsonlRefs = buildEligibleProbe();
    const target = jsonlRefs.get("primary/execution-manifest.json");
    assert.notEqual(target, undefined);
    requireOk(
      putUtf8(
        jsonlRefs,
        "derived/probe-summary.json",
        `{"x":1}\n\n{"evidence_refs":[{"artifact_path":"primary/execution-manifest.json","artifact_sha256":"${sha256Hex(target as Uint8Array)}"}]}`,
      ),
      "jsonl-refs",
    );
    requireOk(putUtf8(jsonlRefs, "derived/more-refs.jsonl", "{\"x\":1}\n\n{\"y\":2}\n"), "jsonl-more");
    assert.equal(verify(jsonlRefs).package_eligibility, "ineligible");
    const arrayEvents = eventIdsIn(new TextEncoder().encode(JSON.stringify([{ event_id: EVENT_ONE }, { nested: [{ event_id: EVENT_TWO }] }])));
    assert.equal(arrayEvents.has(EVENT_ONE), true);
    assert.equal(arrayEvents.has(EVENT_TWO), true);
  });

  it("covers index parsers and unsafe directory entries", () => {
    assert.equal(parsePackageIndex({ schema_version: 1, record_type: "package_index", entries: [null] }).ok, false);
    assert.equal(
      parsePackageIndex({
        schema_version: 1,
        record_type: "package_index",
        entries: [
          { artifact_path: "a.json", artifact_sha256: sha256Hex(""), byte_count: 0 },
          { artifact_path: "a.json", artifact_sha256: sha256Hex(""), byte_count: 0 },
        ],
      }).ok,
      false,
    );
    assert.equal(parseEvidenceIndex({ schema_version: 1, record_type: "evidence_index", entries: [null] }).ok, false);
    assert.equal(
      parsePackageIndex({
        schema_version: 1,
        record_type: "package_index",
        entries: [{ artifact_path: "../x", artifact_sha256: "nope", byte_count: -1, extra: true }],
      }).ok,
      false,
    );
    const root = mkdtempSync(join(tmpdir(), "pkg-cov-"));
    writeFileSync(join(root, "foo\\bar"), "x");
    assert.equal(loadPackageDir(root).ok, false);
    const fifoDir = mkdtempSync(join(tmpdir(), "pkg-fifo-"));
    execSync(`mkfifo "${join(fifoDir, "pipe")}"`);
    assert.equal(loadPackageDir(fifoDir).ok, false);
    const real = mkdtempSync(join(tmpdir(), "pkg-real-"));
    const link = `${real}-link`;
    symlinkSync(real, link);
    assert.equal(loadPackageDir(link).ok, false);
    mkdirSync(join(root, "nested"), { recursive: true });
  });
});
