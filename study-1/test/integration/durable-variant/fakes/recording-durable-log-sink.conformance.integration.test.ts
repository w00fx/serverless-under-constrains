// Conformance of the RecordingDurableLogSink fake to what the production sink does: the handler
// entry writes `JSON.stringify(line)` plus a newline to stderr, so a recorded line must equal the
// JSON round trip of the written one, keep write order, and never alias the caller's object.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DurableCallerFault, StepAttemptFailed } from '../../../../src/durable-variant/durable-fault.ts';
import type { DurableLogLine } from '../../../../src/durable-variant/durable-refund-handler.ts';
import type { Uuid4 } from '../../../../src/record-contract/primitives.ts';
import { RecordingDurableLogSink } from '../support/recording-durable-log-sink.ts';

const ARN = 'arn:aws:lambda:us-east-1:123456789012:function:f:1/durable-execution/e/r';

describe('RecordingDurableLogSink', () => {
  it('records each line as its JSON round trip, in write order', () => {
    const sink = new RecordingDurableLogSink();
    const fault = new DurableCallerFault('NO_ACTIVE_TRIAL', 'req-1', 'none');
    const failed = new StepAttemptFailed({
      lambda_request_id: 'req-1',
      durable_execution_arn: ARN,
      step_attempt: 1,
      attempt_id: 'dddddddd-0000-4000-8000-000000000001' as Uuid4,
      outcome_class: 'AMBIGUOUS',
    });
    sink.write(fault.toLog());
    sink.write(failed.toLog());
    assert.deepEqual(sink.lines(), [
      JSON.parse(JSON.stringify(fault.toLog())) as DurableLogLine,
      JSON.parse(JSON.stringify(failed.toLog())) as DurableLogLine,
    ]);
    assert.deepEqual(sink.events(), ['durable_caller_fault', 'durable_step_attempt_failed']);
  });

  it('keeps a copy: a later change to the written object does not reach the record', () => {
    const sink = new RecordingDurableLogSink();
    const line = {
      level: 'error',
      event: 'durable_execution_failed',
      lambda_request_id: 'req-1',
      durable_execution_arn: ARN,
      error_name: 'StepError',
      detail: 'first',
    } satisfies DurableLogLine;
    sink.write(line);
    const mutable: { detail: string } = line;
    mutable.detail = 'changed';
    assert.equal(sink.lines()[0]?.event, 'durable_execution_failed');
    assert.deepEqual(
      sink.lines().map((recorded) => ('detail' in recorded ? recorded.detail : undefined)),
      ['first'],
    );
  });

  it('starts empty and returns a snapshot the caller cannot grow', () => {
    const sink = new RecordingDurableLogSink();
    const snapshot = sink.lines() as DurableLogLine[];
    snapshot.push({
      level: 'error',
      event: 'durable_caller_fault',
      code: 'NO_ACTIVE_TRIAL',
      lambda_request_id: 'r',
      detail: 'd',
    });
    assert.deepEqual(sink.lines(), []);
    assert.deepEqual(sink.events(), []);
  });
});
