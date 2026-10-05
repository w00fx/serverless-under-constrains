// Conformance of the named fakes the treatment-controller tests use: each behaves like the real
// boundary it replaces on the contract the tests rely on.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ControllerLogRecorder } from '../../support/transport-rehearsal/controller-log-recorder.ts';
import { ControllerFault } from '../../../src/treatment-controller/controller-fault.ts';
import {
  PROBE,
  PROBE_PK,
  callerTimeoutImage,
  controllerHarness,
  probeConfigItem,
  streamInsert,
} from './support/controller-fixtures.ts';
import { ScriptedStreamRecordHandler } from './support/scripted-stream-record-handler.ts';

describe('ScriptedStreamRecordHandler conformance', () => {
  it('returns outcomes of the real controller shape and rejects as the real controller does', async () => {
    const real = controllerHarness(PROBE);
    real.store.seed('control', probeConfigItem({ scenario: 'CONTROL' }));
    const record = streamInsert(callerTimeoutImage('probe'));
    const realOutcome = await real.controller.handle(record);
    const fake = new ScriptedStreamRecordHandler();
    fake.returnNext(realOutcome);
    assert.deepEqual(await fake.handle(record), realOutcome);
    assert.deepEqual(Object.keys(realOutcome).sort(), ['detail', 'outcome', 'partition_key']);

    real.store.scriptReadFault('InternalServerError', { table: 'control' });
    const realFailure = await real.controller.handle(record).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(realFailure instanceof ControllerFault);
    fake.throwNext(realFailure);
    await assert.rejects(fake.handle(record), realFailure);
    await assert.rejects(fake.handle(record), { message: 'unscripted handle of 1; expected a script queued first' });
    assert.equal(fake.handled().length, 3);
  });
});

describe('ControllerLogRecorder conformance', () => {
  it('keeps every line the sink received, in order, like stdout would', () => {
    const recorder = new ControllerLogRecorder();
    recorder.sink({ level: 'warn', event: 'stream_event_unreadable', detail: 'x' });
    recorder.sink({
      level: 'info',
      event: 'controller_record_handled',
      sequence_number: '1',
      outcome: 'signal',
      partition_key: PROBE_PK,
      detail: 'y',
    });
    assert.equal(recorder.lines().length, 2);
    assert.deepEqual(recorder.handledOutcomes(), ['signal']);
  });
});
