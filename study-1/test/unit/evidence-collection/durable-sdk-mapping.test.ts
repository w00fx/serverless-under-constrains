// Lambda durable-execution responses mapped to the catalogue row 62 shapes (BR-RUA-020, BR-RUA-037):
// the service spelling of event types, the detail members the study reads, and a refusal (never a
// guess) for any member outside the service shape.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapDurableExecution, mapHistoryEvent } from '../../../src/evidence-collection/durable-sdk-mapping.ts';
import type { SdkDurableExecution } from '../../../src/evidence-collection/durable-sdk-mapping.ts';
import { sdkEvent, sdkExecution } from '../../support/evidence-collection/collection-fixtures.ts';
import { DEEP_NESTING, parsedTower } from '../../support/kernel/deep-json.ts';

const RUNNING = sdkExecution(1, 'RUNNING');
const ENDED = sdkExecution(2, 'SUCCEEDED');

describe('mapDurableExecution', () => {
  it('maps a running execution without an end and an ended one with its end and version', () => {
    assert.deepEqual(mapDurableExecution(RUNNING), {
      ok: true,
      value: {
        durable_execution_arn: RUNNING.DurableExecutionArn,
        durable_execution_name: 'exec-1',
        status: 'RUNNING',
        started_at: '2026-10-05T12:05:01.000Z',
      },
    });
    assert.deepEqual(mapDurableExecution({ ...ENDED, Version: '3' }), {
      ok: true,
      value: {
        durable_execution_arn: ENDED.DurableExecutionArn,
        durable_execution_name: 'exec-2',
        status: 'SUCCEEDED',
        started_at: '2026-10-05T12:05:02.000Z',
        ended_at: '2026-10-05T12:06:02.000Z',
        version: '3',
      },
    });
  });

  it('refuses each malformed required member', () => {
    const cases: readonly SdkDurableExecution[] = [
      { ...RUNNING, DurableExecutionArn: '' },
      { ...RUNNING, DurableExecutionName: 3 },
      { ...RUNNING, Status: 'PENDING' },
      { ...RUNNING, Status: 'toString' },
      { ...RUNNING, StartTimestamp: '2026-10-05T12:05:01.000Z' },
      { ...RUNNING, StartTimestamp: new Date(Number.NaN) },
    ];
    for (const execution of cases) {
      const mapped = mapDurableExecution(execution);
      assert.match(
        mapped.ok ? '' : mapped.error,
        /^durable execution .* expected a non-empty arn and name, a status in RUNNING, SUCCEEDED/,
      );
    }
  });

  it('refuses a present but malformed end or version', () => {
    for (const execution of [
      { ...ENDED, EndTimestamp: 5 },
      { ...ENDED, Version: '' },
    ]) {
      const mapped = mapDurableExecution(execution);
      assert.match(
        mapped.ok ? '' : mapped.error,
        /expected an absent or valid end Date and an absent or non-empty version$/,
      );
    }
  });

  it('reads only own members (A-05)', () => {
    assert.equal(mapDurableExecution(Object.create(RUNNING) as SdkDurableExecution).ok, false);
  });
});

describe('mapHistoryEvent', () => {
  it('keeps the type, id, name and timestamp', () => {
    assert.deepEqual(mapHistoryEvent(sdkEvent('StepStarted', 2, { Name: 'refund-attempt' })), {
      ok: true,
      value: {
        history_event_id: 2,
        name: 'refund-attempt',
        event_type: 'StepStarted',
        event_timestamp: '2026-10-05T12:05:00.002Z',
      },
    });
  });

  it('reads the retry and error members of a failed step', () => {
    const event = sdkEvent('StepFailed', 3, {
      StepFailedDetails: {
        Error: { Payload: { ErrorType: 'StepError' } },
        RetryDetails: { CurrentAttempt: 1, NextAttemptDelaySeconds: 5 },
      },
    });
    assert.deepEqual(mapHistoryEvent(event), {
      ok: true,
      value: {
        history_event_id: 3,
        current_attempt: 1,
        next_attempt_delay_seconds: 5,
        error_type: 'StepError',
        event_type: 'StepFailed',
        event_timestamp: '2026-10-05T12:05:00.003Z',
      },
    });
  });

  it('reads the request id of a completed invocation and ignores details of another type', () => {
    const event = sdkEvent('InvocationCompleted', 4, {
      InvocationCompletedDetails: { RequestId: 'req-1' },
      StepFailedDetails: { RetryDetails: { CurrentAttempt: 9 } },
    });
    const mapped = mapHistoryEvent(event);
    assert.deepEqual(mapped.ok ? mapped.value : undefined, {
      history_event_id: 4,
      request_id: 'req-1',
      event_type: 'InvocationCompleted',
      event_timestamp: '2026-10-05T12:05:00.004Z',
    });
  });

  it('keeps an event without an id', () => {
    const mapped = mapHistoryEvent({ EventType: 'ExecutionStarted', EventTimestamp: new Date(0) });
    assert.deepEqual(mapped, {
      ok: true,
      value: { event_type: 'ExecutionStarted', event_timestamp: '1970-01-01T00:00:00.000Z' },
    });
  });

  it('refuses a malformed type or timestamp', () => {
    for (const event of [
      sdkEvent('stepStarted', 1),
      sdkEvent('Step-Started', 1),
      { EventType: 7, EventTimestamp: new Date(0) },
      { EventType: 'StepStarted', EventTimestamp: 0 },
    ]) {
      const mapped = mapHistoryEvent(event);
      assert.match(mapped.ok ? '' : mapped.error, /expected a PascalCase event type and a valid EventTimestamp Date$/);
    }
  });

  it('refuses each malformed optional member, naming it', () => {
    const cases: readonly [Readonly<Record<string, unknown>>, string][] = [
      [{ EventId: -1 }, 'history_event_id'],
      [{ EventId: JSON.parse('1e400') }, 'history_event_id'],
      [{ Name: '' }, 'name'],
      [{ StepFailedDetails: { RetryDetails: { CurrentAttempt: 0 } } }, 'current_attempt'],
      [{ StepFailedDetails: { RetryDetails: { NextAttemptDelaySeconds: 1.5 } } }, 'next_attempt_delay_seconds'],
      [{ StepFailedDetails: { Error: { Payload: { ErrorType: '' } } } }, 'error_type'],
      [{ StepFailedDetails: { RequestId: 4 } }, 'request_id'],
    ];
    for (const [extra, member] of cases) {
      const mapped = mapHistoryEvent(sdkEvent('StepFailed', 1, extra));
      assert.match(mapped.ok ? '' : mapped.error, new RegExp(`^history event StepFailed member ${member} is `), member);
    }
  });

  it('stays total on deep and inherited detail members (A-05)', () => {
    const deep = mapHistoryEvent(sdkEvent('StepFailed', 1, { StepFailedDetails: parsedTower('object', DEEP_NESTING) }));
    assert.equal(deep.ok, true);
    const inherited = mapHistoryEvent(
      sdkEvent('StepFailed', 1, {
        StepFailedDetails: Object.create({ RetryDetails: { CurrentAttempt: 2 } }) as object,
      }),
    );
    assert.deepEqual(inherited.ok ? Object.keys(inherited.value) : [], [
      'history_event_id',
      'event_type',
      'event_timestamp',
    ]);
  });
});
