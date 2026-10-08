// Conformance of ControllerLogRecorder with the Lambda entry's sink, which writes each line as
// one JSON line on stdout: the recorder keeps every line in order, each line survives the JSON
// round trip stdout would apply unchanged, and `handledOutcomes` reads only handled-record lines.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ControllerLogLine } from '../../../../src/treatment-controller/stream-consumer.ts';
import { PROBE_PK } from '../../../unit/treatment-controller/support/controller-fixtures.ts';
import { ControllerLogRecorder } from '../../../support/transport-rehearsal/controller-log-recorder.ts';

const LINES: readonly ControllerLogLine[] = [
  { level: 'warn', event: 'stream_event_unreadable', detail: 'x' },
  {
    level: 'info',
    event: 'controller_record_handled',
    sequence_number: '1',
    outcome: 'signal',
    partition_key: PROBE_PK,
    detail: 'y',
  },
  { level: 'warn', event: 'stream_record_unreadable', code: 'STREAM_RECORD_MALFORMED', detail: 'z' },
  {
    level: 'info',
    event: 'controller_record_handled',
    sequence_number: '2',
    outcome: 'record_ignored',
    partition_key: null,
    detail: 'w',
  },
  { level: 'error', event: 'controller_error', detail: 'Error: boom' },
];

describe('ControllerLogRecorder conformance', () => {
  it('keeps every line the sink received, in order and as stdout would carry it', () => {
    const recorder = new ControllerLogRecorder();
    for (const line of LINES) {
      recorder.sink(line);
    }
    assert.deepEqual(recorder.lines(), LINES);
    const stdout = recorder
      .lines()
      .map((line) => `${JSON.stringify(line)}\n`)
      .join('');
    assert.deepEqual(
      stdout
        .split('\n')
        .filter((text) => text !== '')
        .map((text) => JSON.parse(text) as unknown),
      LINES,
    );
    assert.deepEqual(recorder.handledOutcomes(), ['signal', 'record_ignored']);
  });

  it('hands out copies, so a reader cannot rewrite what was logged', () => {
    const recorder = new ControllerLogRecorder();
    recorder.sink({ level: 'warn', event: 'stream_event_unreadable', detail: 'x' });
    const first = recorder.lines() as ControllerLogLine[];
    first.pop();
    assert.equal(recorder.lines().length, 1);
  });
});
