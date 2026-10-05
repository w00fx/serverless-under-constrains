// Conformance of RecordingMutationLog with its contract (design §12.2): one dense, ordered log
// shared by every fake AWS port, so ordering across ports is provable (AC-RUA-008, AC-RUA-014).
// It replaces no platform service, so the contract is checked directly.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RecordingMutationLog } from '../../../support/kernel/recording-mutation-log.ts';

describe('RecordingMutationLog contract', () => {
  it('numbers mutations densely from 1 in call order across ports', () => {
    const log = new RecordingMutationLog();
    assert.equal(log.isEmpty(), true);
    assert.deepEqual(log.record({ port: 'evidence-store', operation: 'write', target: 'execution-manifest.json' }), {
      port: 'evidence-store',
      operation: 'write',
      target: 'execution-manifest.json',
      sequence: 1,
    });
    log.record({ port: 'cloudformation', operation: 'CreateStack', target: 'SucRua-run-1', detail: { tags: 2 } });
    log.record({ port: 'evidence-store', operation: 'write', target: 'trial-manifest.json' });
    assert.equal(log.isEmpty(), false);
    assert.deepEqual(
      log.entries().map((entry) => entry.sequence),
      [1, 2, 3],
    );
    assert.deepEqual(log.entries()[1]?.detail, { tags: 2 });
  });

  it('finds the first matching mutation by port and operation', () => {
    const log = new RecordingMutationLog();
    log.record({ port: 'evidence-store', operation: 'write', target: 'a' });
    log.record({ port: 'cloudformation', operation: 'CreateStack', target: 'b' });
    log.record({ port: 'cloudformation', operation: 'CreateStack', target: 'c' });
    assert.equal(log.firstSequenceOf('cloudformation', 'CreateStack'), 2);
    assert.equal(log.firstSequenceOf('cloudformation', 'DeleteStack'), undefined);
    assert.equal(log.firstSequenceOf('sqs', 'CreateStack'), undefined);
  });

  it('hands out copies so a test cannot rewrite history', () => {
    const log = new RecordingMutationLog();
    log.record({ port: 'p', operation: 'o', target: 't' });
    const copy = log.entries() as unknown[];
    copy.length = 0;
    assert.equal(log.entries().length, 1);
  });
});
