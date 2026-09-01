import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256Hex } from "../../src/protocol-records/index.ts";
import {
  EVIDENCE_INDEX_PATH,
  JOURNAL_PATH,
  PACKAGE_INDEX_PATH,
  createPackageStore,
  createPrefixCheckpoint,
  putUtf8,
  verifyOriginalPackage,
  writeEvidenceIndex,
} from "../../src/evidence-packages/index.ts";
import { jsonPointerExists } from "../../src/evidence-packages/references.ts";
import { parseEvidenceIndex, parsePackageIndex } from "../../src/evidence-packages/entries.ts";
import { NOW, buildEligibleProbe, putCanonical, requireOk } from "../fixtures/evidence-packages/build.ts";

const SEED = 20260831;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATHS = ["../x", "/abs", "a\\b", "a/./b", "a//b", "a/../b", "", "late-evidence/../x"];
const POINTERS = ["relative", "/missing", "/00", "/-", "/~2"];

describe("fuzz-study-1 evidence-packages (seed 20260831)", () => {
  it("rejects generated invalid paths, pointers, and checkpoints", () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < 64; i += 1) {
      const path = PATHS[Math.floor(rng() * PATHS.length)];
      const store = createPackageStore();
      assert.equal(putUtf8(store, path, "x").ok, false, `path seed-step ${i}`);
      const written = writeEvidenceIndex(store, { [String(path)]: "primary" });
      assert.equal(written.ok, false, `index seed-step ${i}`);
      assert.equal(jsonPointerExists({ a: 1 }, POINTERS[Math.floor(rng() * POINTERS.length)] ?? "relative"), false);
    }
    for (let i = 0; i < 32; i += 1) {
      const checkpoint = createPrefixCheckpoint({
        schema_version: rng() < 0.5 ? 1 : 0,
        record_type: "coordination_prefix_checkpoint",
        path: rng() < 0.5 ? "primary/coordination/journal.jsonl" : "../j",
        prefix_byte_count: rng() < 0.5 ? 1 : -1,
        prefix_digest: rng() < 0.5 ? sha256Hex("a") : "nope",
        last_included_event_id: "11111111-1111-4111-8111-111111111111",
        last_included_sequence: rng() < 0.5 ? 1 : 0,
        checkpoint_time: rng() < 0.5 ? NOW : "nope",
      });
      if (checkpoint.ok) {
        const store = createPackageStore();
        const verified = verifyOriginalPackage(store, {
          selected_amendment_head_sha256: sha256Hex(String(i)),
          now: () => NOW,
        });
        assert.equal(verified.ok && verified.value.package_eligibility === "ineligible", true);
      } else {
        assert.equal(checkpoint.ok, false, `checkpoint seed-step ${i}`);
      }
    }
  });

  it("rejects self-indexed, truncated-journal, and digest-mutated packages", () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < 32; i += 1) {
      const store = buildEligibleProbe();
      const pick = Math.floor(rng() * 4);
      if (pick === 0) {
        const evidenceBytes = store.get(EVIDENCE_INDEX_PATH);
        const evidence = requireOk(
          parseEvidenceIndex(JSON.parse(new TextDecoder().decode(evidenceBytes))),
          `self-ei-${i}`,
        );
        evidence.entries.push({
          artifact_path: EVIDENCE_INDEX_PATH,
          artifact_sha256: sha256Hex(evidenceBytes as Uint8Array),
          byte_count: (evidenceBytes as Uint8Array).byteLength,
          classification: "derived",
        });
        putCanonical(store, EVIDENCE_INDEX_PATH, evidence);
      } else if (pick === 1) {
        const packageBytes = store.get(PACKAGE_INDEX_PATH);
        const pack = requireOk(
          parsePackageIndex(JSON.parse(new TextDecoder().decode(packageBytes))),
          `self-pi-${i}`,
        );
        pack.entries.push({
          artifact_path: PACKAGE_INDEX_PATH,
          artifact_sha256: sha256Hex(packageBytes as Uint8Array),
          byte_count: (packageBytes as Uint8Array).byteLength,
        });
        putCanonical(store, PACKAGE_INDEX_PATH, pack);
      } else if (pick === 2) {
        const journal = store.get(JOURNAL_PATH);
        assert.notEqual(journal, undefined, `journal seed-step ${i}`);
        store.set(JOURNAL_PATH, (journal as Uint8Array).subarray(0, Math.max(1, (journal as Uint8Array).byteLength - 1)));
      } else {
        store.set("primary/execution-manifest.json", new Uint8Array([i + 1, 2, 3]));
      }
      const verified = verifyOriginalPackage(store, {
        selected_amendment_head_sha256: null,
        now: () => NOW,
      });
      assert.equal(
        verified.ok && verified.value.package_eligibility === "ineligible",
        true,
        `payload seed-step ${i} pick ${pick}`,
      );
    }
  });
});
