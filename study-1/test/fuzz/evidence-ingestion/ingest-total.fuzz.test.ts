// AC-RUA-046 feed and design §8.2 ("all steps are total: no input bytes can make them throw"):
// ingestion and the G2, G3 and G8 assessments return a classification for any artifact bytes,
// paths and JSON values, with bounded findings in a deterministic order (A-05, A-12). The
// BR-RUA-034 rules hold as properties: equivalent copies always collapse, whatever their member
// order, and a source instance's gap count is exact for any set of sequences. A record root stays
// closed to own members named like inherited properties (A-07; review WP-12 R1).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { assessEvidenceIntegrity } from '../../../src/evidence-ingestion/evidence-integrity-gate.ts';
import { assessIdentityIntegrity } from '../../../src/evidence-ingestion/identity-integrity-gate.ts';
import { sortFindings } from '../../../src/evidence-ingestion/ingestion-findings.ts';
import type { IngestedEvidence, IngestionInput } from '../../../src/evidence-ingestion/ingestion-model.ts';
import { checkSequenceDensity } from '../../../src/evidence-ingestion/sequence-density.ts';
import { assessTraceability } from '../../../src/evidence-ingestion/traceability-gate.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { INGESTION_FINDING_CODES } from '../../../src/record-contract/records/group-c/vocabulary.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import {
  artifactValues,
  ingest,
  jsonl,
  subjectOf,
  trialInput,
} from '../../unit/evidence-ingestion/support/evidence-fixtures.ts';
import { INSTANCE, indexedEvent, uuid } from '../../unit/evidence-ingestion/support/indexed-events.ts';

const CLEAN = trialInput();
const CALLER = `${subjectOf(CLEAN)}/journals/caller-journal.jsonl`;
const CALLER_LINES = artifactValues(CLEAN, CALLER);
const KNOWN_CODES: ReadonlySet<string> = new Set(INGESTION_FINDING_CODES);
/** A finding detail is bounded text: 200 characters plus the truncation marker. */
const DETAIL_LIMIT = 200 + '…[truncated]'.length;
const GATE_VALUES: ReadonlySet<string> = new Set(['verified', 'invalid', 'unverified']);
const encoder = new TextEncoder();

const pathArbitrary = fc.oneof(
  fc.constantFrom(...CLEAN.expected.map((artifact) => artifact.path)),
  fc.constantFrom('provider/provider-journal.jsonl', 'extra/notes.json', '/abs.json', 'a/../b.jsonl', ''),
);
const bytesArbitrary = fc.oneof(
  fc.uint8Array({ maxLength: 64 }),
  fc.array(fc.jsonValue({ maxDepth: 3 }) as fc.Arbitrary<JsonValue>, { maxLength: 4 }).map((values) => jsonl(values)),
  fc.json({ maxDepth: 3 }).map((text) => encoder.encode(text)),
);

function assertWellFormed(evidence: IngestedEvidence): void {
  for (const finding of evidence.findings) {
    assert.ok(KNOWN_CODES.has(finding.code), finding.code);
    assert.ok(finding.detail.length > 0 && finding.detail.length <= DETAIL_LIMIT, finding.detail);
    assert.ok(Number.isSafeInteger(finding.occurrences) && finding.occurrences >= 1);
  }
  assert.deepEqual(evidence.findings, sortFindings(evidence.findings));
  const gates = [assessTraceability(evidence), assessIdentityIntegrity(evidence), assessEvidenceIntegrity(evidence)];
  for (const gate of gates) {
    assert.ok(GATE_VALUES.has(gate.value));
    assert.equal(gate.value === 'verified', gate.reasons.length === 0);
  }
}

function withCaller(values: readonly JsonValue[]): IngestionInput {
  return {
    ...CLEAN,
    artifacts: CLEAN.artifacts.map((artifact) =>
      artifact.path === CALLER ? { path: CALLER, bytes: jsonl(values) } : artifact,
    ),
  };
}

describe('ingestion is total (AC-RUA-046, design §8.2)', () => {
  it('classifies any set of artifact paths and bytes, deterministically (property)', () => {
    const artifactsArbitrary = fc.array(fc.record({ path: pathArbitrary, bytes: bytesArbitrary }), { maxLength: 6 });
    fc.assert(
      fc.property(artifactsArbitrary, (artifacts) => {
        const input: IngestionInput = {
          artifacts,
          expected: CLEAN.expected,
          execution_scope_artifacts: artifacts.slice(0, 1),
        };
        const evidence = ingest(input);
        assertWellFormed(evidence);
        assert.deepEqual(ingest(input).findings, evidence.findings);
      }),
      fuzzParameters(),
    );
  });

  it('classifies a real trial with one corrupted byte; unreadable required bytes are never integral (property)', () => {
    const files = CLEAN.artifacts;
    const corruption = fc.tuple(fc.nat({ max: files.length - 1 }), fc.nat(), fc.integer({ min: 1, max: 255 }));
    fc.assert(
      fc.property(corruption, ([fileIndex, offset, mask]) => {
        const target = files[fileIndex];
        if (target === undefined || target.bytes.length === 0) {
          return;
        }
        const bytes = target.bytes.slice();
        const at = offset % bytes.length;
        bytes[at] = (bytes[at] ?? 0) ^ mask;
        const artifacts = files.map((artifact) => (artifact === target ? { path: target.path, bytes } : artifact));
        const evidence = ingest({ ...CLEAN, artifacts });
        assertWellFormed(evidence);
        const corrupted = evidence.artifacts.get(target.path);
        const unreadable =
          corrupted?.parse_status === 'unparseable' ||
          corrupted?.records.some((record) => record.validity === 'schema_invalid') === true;
        if (corrupted?.requirement === 'required' && unreadable) {
          assert.equal(assessEvidenceIntegrity(evidence).value, 'invalid');
        }
      }),
      fuzzParameters(),
    );
  });
});

describe('closed record roots (A-05, A-07)', () => {
  // Review finding WP-12 R1: a parsed own member named like an Object.prototype property is a
  // member the closed root refuses, also while absent correlation members are filled in.
  const inheritedNames = Object.getOwnPropertyNames(Object.prototype);
  const correlationUnits: readonly (readonly string[])[] = [
    ['run_id'],
    ['execution_manifest_sha256'],
    ['trial_id', 'trial_manifest_sha256'],
  ];

  it('classifies a caller event with an own inherited-name member as schema-invalid, whatever correlation it lacks (property)', () => {
    const scenario = fc.record({
      line: fc.nat({ max: CALLER_LINES.length - 1 }),
      name: fc.constantFrom(...inheritedNames),
      member: fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<JsonValue>,
      dropped: fc.subarray([...correlationUnits]),
    });
    fc.assert(
      fc.property(scenario, ({ line, name, member, dropped }) => {
        const absent = new Set(dropped.flat());
        const kept = Object.entries(CALLER_LINES[line] as Readonly<Record<string, JsonValue>>).filter(
          ([key]) => !absent.has(key),
        );
        const tampered = `{${JSON.stringify(name)}:${JSON.stringify(member)},${JSON.stringify(Object.fromEntries(kept)).slice(1)}`;
        const lines = CALLER_LINES.map((value) => JSON.stringify(value)).toSpliced(line, 1, tampered);
        const evidence = ingest({
          ...CLEAN,
          artifacts: CLEAN.artifacts.map((artifact) =>
            artifact.path === CALLER ? { path: CALLER, bytes: encoder.encode(`${lines.join('\n')}\n`) } : artifact,
          ),
        });
        assert.equal(evidence.artifacts.get(CALLER)?.records[line]?.validity, 'schema_invalid');
        assert.equal(assessEvidenceIntegrity(evidence).value, 'invalid');
      }),
      fuzzParameters(),
    );
  });
});

describe('BR-RUA-034 rules as properties', () => {
  it('collapses equivalent copies of caller events whatever their member order (property)', () => {
    const picks = fc.array(fc.nat({ max: CALLER_LINES.length - 1 }), { minLength: 1, maxLength: 4 });
    fc.assert(
      fc.property(picks, fc.boolean(), (indexes, reverse) => {
        const copies = indexes.map((index) => {
          const entries = Object.entries(CALLER_LINES[index] as Readonly<Record<string, JsonValue>>);
          return Object.fromEntries(reverse ? entries.toReversed() : entries);
        });
        const evidence = ingest(withCaller([...CALLER_LINES, ...copies]));
        assert.equal(evidence.diagnostics.collapsed_duplicate_count, indexes.length);
        assert.deepEqual(
          [...new Set(evidence.findings.map((finding) => finding.code))],
          ['EQUIVALENT_DUPLICATE_COLLAPSED'],
        );
        assert.equal(assessEvidenceIntegrity(evidence).value, 'verified');
      }),
      fuzzParameters(),
    );
  });

  it('counts the absent sequences of an instance exactly and names the first (property)', () => {
    const sequencesArbitrary = fc.uniqueArray(fc.integer({ min: 1, max: 64 }), { minLength: 1, maxLength: 20 });
    fc.assert(
      fc.property(sequencesArbitrary, (sequences) => {
        const events = sequences.map((sequence, index) =>
          indexedEvent({ event_id: uuid(index + 1), source_sequence: sequence }),
        );
        const density = checkSequenceDensity(events);
        const max = Math.max(...sequences);
        const absent = Array.from({ length: max }, (_, index) => index + 1).filter(
          (sequence) => !sequences.includes(sequence),
        );
        const view = density.instances.get(`conventional_caller#${INSTANCE}`);
        assert.equal(view?.missing_sequences, absent.length);
        assert.equal(view.gapped, absent.length > 0);
        const gap = density.findings.find((finding) => finding.code === 'SOURCE_SEQUENCE_GAP');
        assert.equal(gap === undefined, absent.length === 0);
        assert.ok(gap === undefined || gap.detail.endsWith(`first ${String(absent[0])}`));
      }),
      fuzzParameters(),
    );
  });
});
