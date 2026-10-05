// The controller function's invocation body: one stream event, records in order, one JSON log
// line per record; unreadable records are skipped, controller failures are logged and rethrown so
// the mapping retries within its bound (design §9.5).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodeAttributeMap } from '../../../src/durable-store/attribute-value-codec.ts';
import { ControllerFault } from '../../../src/treatment-controller/controller-fault.ts';
import { consumeStreamEvent } from '../../../src/treatment-controller/stream-consumer.ts';
import { ControllerLogRecorder } from '../../support/transport-rehearsal/controller-log-recorder.ts';
import { PROBE_PK, callerTimeoutImage } from './support/controller-fixtures.ts';
import { ScriptedStreamRecordHandler } from './support/scripted-stream-record-handler.ts';

const IMAGE = callerTimeoutImage('probe');

function record(sequence: string): Readonly<Record<string, unknown>> {
  return { eventName: 'INSERT', dynamodb: { SequenceNumber: sequence, NewImage: encodeAttributeMap(IMAGE) } };
}

describe('consumeStreamEvent', () => {
  it('hands each readable record to the controller in order and logs its outcome', async () => {
    const handler = new ScriptedStreamRecordHandler();
    const logs = new ControllerLogRecorder();
    handler.returnNext({ outcome: 'signal', partition_key: PROBE_PK, detail: 'signalled' });
    handler.returnNext({ outcome: 'record_ignored', partition_key: null, detail: 'other' });
    await consumeStreamEvent({ Records: [record('1'), record('2')] }, handler, logs.sink);
    assert.deepEqual(
      handler.handled().map((handled) => handled.sequence_number),
      ['1', '2'],
    );
    assert.deepEqual(logs.lines(), [
      {
        level: 'info',
        event: 'controller_record_handled',
        sequence_number: '1',
        outcome: 'signal',
        partition_key: PROBE_PK,
        detail: 'signalled',
      },
      {
        level: 'info',
        event: 'controller_record_handled',
        sequence_number: '2',
        outcome: 'record_ignored',
        partition_key: null,
        detail: 'other',
      },
    ]);
  });

  it('logs and skips a record it cannot read, then continues', async () => {
    const handler = new ScriptedStreamRecordHandler();
    const logs = new ControllerLogRecorder();
    handler.returnNext({ outcome: 'late_rejected', partition_key: PROBE_PK, detail: 'late' });
    await consumeStreamEvent({ Records: [{ eventName: 'INSERT' }, record('3')] }, handler, logs.sink);
    assert.equal(handler.handled().length, 1);
    assert.deepEqual(logs.lines()[0], {
      level: 'warn',
      event: 'stream_record_unreadable',
      code: 'STREAM_RECORD_MALFORMED',
      detail: 'eventName is string and dynamodb is undefined; expected a string and an object',
    });
    assert.deepEqual(logs.handledOutcomes(), ['late_rejected']);
  });

  it('logs an event without a Records array and handles nothing', async () => {
    for (const event of [null, {}, { Records: 'x' }, 7]) {
      const handler = new ScriptedStreamRecordHandler();
      const logs = new ControllerLogRecorder();
      await consumeStreamEvent(event, handler, logs.sink);
      assert.equal(handler.handled().length, 0);
      assert.equal(logs.lines()[0]?.event, 'stream_event_unreadable');
    }
    const logs = new ControllerLogRecorder();
    await consumeStreamEvent({ Records: null }, new ScriptedStreamRecordHandler(), logs.sink);
    assert.deepEqual(logs.lines(), [
      {
        level: 'warn',
        event: 'stream_event_unreadable',
        detail: 'stream event Records is object; expected an array of stream records',
      },
    ]);
  });

  it('logs a ControllerFault as its structured line and rethrows it', async () => {
    const handler = new ScriptedStreamRecordHandler();
    const logs = new ControllerLogRecorder();
    const fault = new ControllerFault('STATE_UNREADABLE', PROBE_PK, 'ProvisionedThroughputExceededException');
    handler.throwNext(fault);
    await assert.rejects(consumeStreamEvent({ Records: [record('4')] }, handler, logs.sink), fault);
    assert.deepEqual(logs.lines(), [fault.toLog()]);
  });

  it('logs any other error as controller_error and rethrows it', async () => {
    const handler = new ScriptedStreamRecordHandler();
    const logs = new ControllerLogRecorder();
    const error = new TypeError('boom');
    handler.throwNext(error);
    await assert.rejects(consumeStreamEvent({ Records: [record('5'), record('6')] }, handler, logs.sink), error);
    assert.deepEqual(logs.lines(), [{ level: 'error', event: 'controller_error', detail: 'TypeError: boom' }]);
    assert.equal(handler.handled().length, 1, 'records after a failure are left to the retry');
  });
});
