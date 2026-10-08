// The coordination prefix checkpoint (BR-RUA-044): taken at transport freeze over the journal's
// complete lines, it still holds when the journal only grows, and fails when a prefix byte, the
// length or the last event changes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPrefixCheckpoint,
  checkPrefixCheckpoint,
  lastPrefixEvent,
} from '../../../src/evidence-package/prefix-checkpoint.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { DEEP_NESTING, towerText } from '../../support/kernel/deep-json.ts';
import { PROBE_ID, at, digest, uuid } from '../../support/record-contract/record-builders.ts';
import { utf8 } from '../../support/evidence-package/package-files.ts';

const validator = createRecordValidator();
const LINE_1 = `{"event_id":"${uuid(1)}","source_sequence":1}\n`;
const LINE_2 = `{"event_id":"${uuid(2)}","source_sequence":2}\n`;

function checkpointOf(journal: string): ReturnType<typeof buildPrefixCheckpoint> {
  return buildPrefixCheckpoint({
    journal: utf8(journal),
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: digest('manifest'),
    checkpointed_at: at(4),
  });
}

describe('buildPrefixCheckpoint', () => {
  it('checkpoints the complete lines and leaves a partial line out', () => {
    const built = checkpointOf(`${LINE_1}${LINE_2}{"event_id":"partial`);
    assert.ok(built.ok);
    assert.equal(built.value.prefix_byte_count, utf8(LINE_1 + LINE_2).length);
    assert.equal(built.value.prefix_sha256, sha256Hex(utf8(LINE_1 + LINE_2)));
    assert.deepEqual([built.value.last_event_id, built.value.last_source_sequence], [uuid(2), 2]);
    assert.equal(built.value.journal_path, 'coordination/coordination-journal.jsonl');
    assert.ok(
      validator.validateAs('coordination_prefix_checkpoint', JSON.parse(JSON.stringify(built.value)) as never).valid,
    );
  });

  it('refuses a journal without a complete line or with an unreadable last line', () => {
    for (const journal of [
      '',
      '{"event_id":',
      '[]\n',
      `{"event_id":"${uuid(1)}","source_sequence":0}\n`,
      '\xff\n',
      `{"source_sequence":1}\n`,
    ]) {
      const built = checkpointOf(journal);
      assert.ok(!built.ok, JSON.stringify(journal));
      assert.equal(built.error.code, 'PREFIX_LAST_EVENT_UNREADABLE');
      assert.equal(built.error.artifact_path, 'coordination/coordination-journal.jsonl');
    }
  });
});

describe('checkPrefixCheckpoint', () => {
  const built = checkpointOf(LINE_1);
  assert.ok(built.ok);
  const checkpoint = built.value;

  it('holds for the same journal and for a journal that only grew', () => {
    assert.equal(checkPrefixCheckpoint(checkpoint, utf8(LINE_1)), undefined);
    assert.equal(checkPrefixCheckpoint(checkpoint, utf8(LINE_1 + LINE_2)), undefined);
  });

  it('fails for a shorter journal, an altered prefix byte and a different last event', () => {
    assert.match(checkPrefixCheckpoint(checkpoint, utf8('{}')) ?? '', /exceeds the 2-byte journal/);
    assert.match(checkPrefixCheckpoint(checkpoint, utf8(LINE_1.replace('1}', '9}') + LINE_2)) ?? '', /hash to/);
    const forged = { ...checkpoint, last_source_sequence: 7 };
    assert.match(checkPrefixCheckpoint(forged, utf8(LINE_1)) ?? '', /does not end with event/);
    const otherEvent = { ...checkpoint, last_event_id: uuid(9) };
    assert.match(checkPrefixCheckpoint(otherEvent, utf8(LINE_1)) ?? '', /does not end with event/);
  });
});

describe('lastPrefixEvent totality (A-05)', () => {
  it('rejects a 100,000-level last line, non-finite numbers and inherited names without throwing', () => {
    for (const line of [
      towerText('object', DEEP_NESTING, '1'),
      `{"event_id":"${uuid(1)}","source_sequence":1e400}`,
      '{"__proto__":{"event_id":"x","source_sequence":1}}',
      '{"constructor":1}',
    ]) {
      assert.equal(lastPrefixEvent(utf8(`${line}\n`)).ok, false);
    }
  });

  it('reads the last of several lines', () => {
    assert.deepEqual(lastPrefixEvent(utf8(LINE_1 + LINE_2)), {
      ok: true,
      value: { event_id: uuid(2), source_sequence: 2 },
    });
  });
});
