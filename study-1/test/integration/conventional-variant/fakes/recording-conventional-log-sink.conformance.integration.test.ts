// Conformance of the RecordingConventionalLogSink fake to what the production sink does: the
// handler shell writes `JSON.stringify(line)` plus a newline to stderr, so a recorded line must
// equal the JSON round trip of the written one, keep write order, and never alias the caller's
// object.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConventionalCallerFault,
  DeliveryFailurePropagated,
} from '../../../../src/conventional-variant/conventional-fault.ts';
import type { ConventionalLogLine } from '../../../../src/conventional-variant/conventional-lambda-entry.ts';
import { RecordingConventionalLogSink } from '../support/recording-conventional-log-sink.ts';

describe('RecordingConventionalLogSink', () => {
  it('records each line as its JSON round trip, in write order', () => {
    const sink = new RecordingConventionalLogSink();
    const fault = new ConventionalCallerFault('NO_ACTIVE_TRIAL', 'req-1', 'none');
    const failure = new DeliveryFailurePropagated('req-2', 'message-1', 2);
    sink.write(fault.toLog());
    sink.write(failure.toLog());
    assert.deepEqual(sink.lines(), [
      JSON.parse(JSON.stringify(fault.toLog())) as ConventionalLogLine,
      JSON.parse(JSON.stringify(failure.toLog())) as ConventionalLogLine,
    ]);
    assert.deepEqual(sink.events(), ['conventional_caller_fault', 'conventional_delivery_failed']);
  });

  it('keeps a copy: a later change to the written object does not reach the record', () => {
    const sink = new RecordingConventionalLogSink();
    const line = {
      level: 'error',
      event: 'conventional_caller_error',
      lambda_request_id: 'req-1',
      error_name: 'RangeError',
      detail: 'first',
    } satisfies ConventionalLogLine;
    sink.write(line);
    const mutable: { detail: string } = line;
    mutable.detail = 'changed';
    assert.deepEqual(
      sink.lines().map((recorded) => ('detail' in recorded ? recorded.detail : undefined)),
      ['first'],
    );
  });

  it('starts empty and returns a snapshot the caller cannot grow', () => {
    const sink = new RecordingConventionalLogSink();
    const snapshot = sink.lines() as ConventionalLogLine[];
    snapshot.push({
      level: 'error',
      event: 'conventional_caller_fault',
      code: 'NO_ACTIVE_TRIAL',
      lambda_request_id: 'r',
      detail: 'd',
    });
    assert.deepEqual(sink.lines(), []);
    assert.deepEqual(sink.events(), []);
  });
});
