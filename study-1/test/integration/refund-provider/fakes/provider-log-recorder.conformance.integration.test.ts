// Conformance of ProviderLogRecorder with the Lambda entry's sink (`jsonLineLogSink` over
// stderr): the recorder keeps every line the provider logs, in order, each exactly as the
// production sink's JSON line parses back, and hands out copies.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProviderLogLine } from '../../../../src/refund-provider/provider-log.ts';
import { jsonLineLogSink } from '../../../../src/refund-provider/provider-log.ts';
import { ProviderLogRecorder } from '../../../unit/refund-provider/support/provider-log-recorder.ts';

const LINES: readonly ProviderLogLine[] = [
  {
    level: 'warn',
    event: 'treatment_read_failed',
    provider_call_id: '99999999-0000-4000-8000-000000000001',
    code: 'UndecodableItem',
    detail: 'control item p/treatment: state string "x"; expected one of ARMED',
  },
  {
    level: 'error',
    event: 'provider_fault',
    code: 'COMMIT_FAILED',
    phase: 'before_commit',
    provider_call_id: null,
    detail: 'COMMIT_FAILED: commit not applied',
  },
  { level: 'error', event: 'provider_unexpected_error', error_name: 'TypeError', detail: 'boom' },
];

describe('ProviderLogRecorder conformance', () => {
  it('records exactly what the production JSON-line sink writes, in order', () => {
    const recorder = new ProviderLogRecorder();
    const stderr: string[] = [];
    const production = jsonLineLogSink((text) => {
      stderr.push(text);
    });
    for (const line of LINES) {
      recorder.sink(line);
      production(line);
    }
    assert.deepEqual(recorder.lines(), LINES);
    assert.deepEqual(
      stderr.map((text) => JSON.parse(text) as unknown),
      recorder.lines(),
    );
    assert.deepEqual(recorder.events(), ['treatment_read_failed', 'provider_fault', 'provider_unexpected_error']);
  });

  it('hands out copies, so a reader cannot rewrite what was logged', () => {
    const recorder = new ProviderLogRecorder();
    const [line] = LINES;
    assert.ok(line !== undefined);
    recorder.sink(line);
    const copy = recorder.lines() as ProviderLogLine[];
    copy.pop();
    assert.equal(recorder.lines().length, 1);
  });
});
