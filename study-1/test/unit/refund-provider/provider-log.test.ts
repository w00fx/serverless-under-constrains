// The provider's JSON-line log sink: each line is written as exactly one JSON text and a newline,
// so a log reader can split stderr by line and parse each one back to the logged value.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProviderLogLine } from '../../../src/refund-provider/provider-log.ts';
import { jsonLineLogSink } from '../../../src/refund-provider/provider-log.ts';
import { ProviderFault } from '../../../src/refund-provider/provider-fault.ts';

describe('jsonLineLogSink', () => {
  it('writes each line as one JSON text followed by a newline, in order', () => {
    const written: string[] = [];
    const log = jsonLineLogSink((text) => {
      written.push(text);
    });
    const readFailed: ProviderLogLine = {
      level: 'warn',
      event: 'treatment_read_failed',
      provider_call_id: '99999999-0000-4000-8000-000000000001',
      code: 'ThrottlingException',
      detail: 'control read p/treatment failed: ThrottlingException',
    };
    const fault = new ProviderFault('STATE_UNREADABLE', 'before_commit', undefined, 'x\ny').toLog();
    log(readFailed);
    log(fault);

    assert.equal(written.length, 2);
    assert.ok(written.every((text) => text.endsWith('\n') && text.indexOf('\n') === text.length - 1));
    assert.deepEqual(
      written.map((text) => JSON.parse(text) as unknown),
      [readFailed, fault],
    );
  });
});
