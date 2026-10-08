// `buildJournalEvent` and `toJournalEntry` assemble records through one documented cast each
// (journal-event.ts, journal-entry.ts). This test is the runtime check of those casts for every
// event record type the writer can emit: it takes WP-02's canonical, schema-valid example of
// each type, splits it into the record-specific body and the envelope inputs, rebuilds it with
// the builder and requires (1) the rebuilt event to equal the example exactly, (2) the real Ajv
// validator to accept it after a round trip through the serialization kernel, and (3) the
// stored item to be the event plus its key and nothing else.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toJournalEntry } from '../../../src/event-journal/journal-entry.ts';
import type { EventBody, EventEnvelopeInput } from '../../../src/event-journal/journal-event.ts';
import { buildJournalEvent } from '../../../src/event-journal/journal-event.ts';
import type { JournalScope } from '../../../src/event-journal/journal-scope.ts';
import { journalItemKey } from '../../../src/event-journal/journal-scope.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import type { EventSource } from '../../../src/record-contract/envelope.ts';
import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import type { ExecutionIdentity, Sha256Hex, Uuid4, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { EventRecordType } from '../../../src/record-contract/record-types.ts';
import { EVENT_RECORD_TYPES } from '../../../src/record-contract/record-types.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { CANONICAL_EXAMPLES } from '../../contract/record-contract/group-b/examples/group-b-examples.ts';

const validator = createRecordValidator();

const ENVELOPE_FIELDS = [
  'schema_version',
  'record_type',
  'event_id',
  'run_id',
  'variant_validation_id',
  'transport_probe_id',
  'execution_manifest_sha256',
  'trial_id',
  'trial_manifest_sha256',
  'occurred_at',
  'source',
  'source_instance_id',
  'source_sequence',
  'causation_event_ids',
] as const;

type ExampleFields = Readonly<Record<string, unknown>>;

function executionOf(example: ExampleFields): ExecutionIdentity {
  if (typeof example['run_id'] === 'string') {
    return { execution_kind: 'RUN', run_id: example['run_id'] as Uuid4 };
  }
  if (typeof example['transport_probe_id'] === 'string') {
    return { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: example['transport_probe_id'] as Uuid4 };
  }
  return { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: example['variant_validation_id'] as Uuid4 };
}

function scopeOf(example: ExampleFields): JournalScope {
  const partition =
    typeof example['trial_id'] === 'string'
      ? {
          kind: 'trial' as const,
          trial_id: example['trial_id'] as Uuid4,
          trial_manifest_sha256: example['trial_manifest_sha256'] as Sha256Hex,
        }
      : { kind: 'execution' as const };
  return {
    execution: executionOf(example),
    execution_manifest_sha256: example['execution_manifest_sha256'] as Sha256Hex,
    partition,
  };
}

function envelopeOf(example: ExampleFields): EventEnvelopeInput {
  return {
    scope: scopeOf(example),
    source: example['source'] as EventSource,
    source_instance_id: example['source_instance_id'] as Uuid4,
    source_sequence: example['source_sequence'] as number,
    event_id: example['event_id'] as Uuid4,
    occurred_at: example['occurred_at'] as UtcMillis,
    causation: (example['causation_event_ids'] as readonly Uuid4[] | undefined) ?? [],
  };
}

const ENVELOPE_FIELD_SET: ReadonlySet<string> = new Set(ENVELOPE_FIELDS);

function bodyOf<T extends EventRecordType>(example: ExampleFields): EventBody<T> {
  return Object.fromEntries(Object.entries(example).filter(([name]) => !ENVELOPE_FIELD_SET.has(name))) as EventBody<T>;
}

describe('the journal builder reproduces every event record type exactly', () => {
  it('covers every event record type', () => {
    // 39 kind-E record types (WP-00 catalogue, addendum §3 warm-up records included).
    assert.equal(EVENT_RECORD_TYPES.length, 39);
    for (const type of EVENT_RECORD_TYPES) {
      assert.equal(typeof CANONICAL_EXAMPLES[type], 'function', type);
    }
  });

  for (const type of EVENT_RECORD_TYPES) {
    it(`${type}: rebuilt from its body equals the canonical example and validates`, () => {
      const example = CANONICAL_EXAMPLES[type]() as unknown as ExampleFields;
      const input = envelopeOf(example);
      const event = buildJournalEvent(type, bodyOf(example), input);
      assert.deepStrictEqual(event, example);
      const parsed = parseJsonDocument(serializeRecordFile(event));
      assert.ok(parsed.ok, type);
      const validation = validator.validateAs(type, parsed.value);
      assert.equal(validation.valid, true, JSON.stringify(validation));
      const key = journalItemKey(input.scope, input.source, input.source_instance_id, input.source_sequence);
      assert.deepStrictEqual(toJournalEntry(key, event).item, { ...example, pk: key.pk, sk: key.sk });
    });
  }
});
