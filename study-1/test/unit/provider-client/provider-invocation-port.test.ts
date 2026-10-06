// transportResultOf: what a port resolved, checked at the dispatch boundary. Regression (WP-06
// review round 2): a defective port that resolved `undefined` made parseProviderResponse read
// `result.kind` and throw a TypeError after `dispatch_started`, so performAttempt rejected with
// no attempt_outcome_recorded. Every resolved value now becomes a well-formed settlement.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { ProviderTransportResult } from '../../../src/provider-client/provider-invocation-port.ts';
import {
  MALFORMED_PORT_RESULT_NAME,
  transportResultOf,
} from '../../../src/provider-client/provider-invocation-port.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { invokeResponse, transportError } from '../../support/provider-client/provider-client-fixtures.ts';

const EXPECTED_SHAPE = 'expected a ProviderTransportResult (kind "response" or "transport_error" with typed fields)';

function malformedResult(typeName: string): ProviderTransportResult {
  return transportError(
    MALFORMED_PORT_RESULT_NAME,
    `the provider invocation port resolved ${typeName}; ${EXPECTED_SHAPE}`,
  );
}

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

describe('transportResultOf', () => {
  it('copies a well-formed settlement field by field', () => {
    const response = { ...invokeResponse(new Uint8Array([1])), function_error: 'Unhandled' };
    assert.deepEqual(transportResultOf(response), response);
    assert.notEqual(transportResultOf(response), response);
    const withoutHeaders = invokeResponse(new Uint8Array());
    assert.deepEqual(transportResultOf({ ...withoutHeaders, executed_version: undefined }), {
      ...withoutHeaders,
      executed_version: undefined,
    });
    assert.deepEqual(
      transportResultOf(transportError('TimeoutError', 'socket hang up')),
      transportError('TimeoutError', 'socket hang up'),
    );
    const throttled = { ...transportError('TooManyRequestsException', 'Rate exceeded'), http_status: 429 };
    assert.deepEqual(transportResultOf(throttled), throttled);
  });

  it('names what a port resolved when it is not a settlement, with the expected shape', () => {
    const response = invokeResponse(new Uint8Array());
    const cases: readonly (readonly [unknown, string])[] = [
      [undefined, 'undefined'],
      [null, 'null'],
      ['response', 'string'],
      [200, 'number'],
      [{}, 'object'],
      [{ ...response, kind: 'Response' }, 'object'],
      [{ ...response, status_code: '200' }, 'object'],
      [{ ...response, executed_version: 7 }, 'object'],
      [{ ...response, function_error: null }, 'object'],
      [{ ...response, payload: [1, 2] }, 'object'],
      [{ ...response, payload: 'bytes' }, 'object'],
      [{ ...transportError('TimeoutError', 'x'), error_name: 1 }, 'object'],
      [{ ...transportError('TimeoutError', 'x'), message: undefined }, 'object'],
      [{ ...transportError('TimeoutError', 'x'), http_status: '500' }, 'object'],
    ];
    for (const [value, typeName] of cases) {
      assert.deepEqual(transportResultOf(value), malformedResult(typeName), JSON.stringify(value));
    }
  });

  it('is a malformed result, not a throw, for throwing getters and a revoked proxy', () => {
    const throwingKind = Object.defineProperty({}, 'kind', {
      get: (): never => {
        throw new Error('getter');
      },
    });
    assert.deepEqual(transportResultOf(throwingKind), malformedResult('object'));
    assert.deepEqual(transportResultOf(revokedProxy()), malformedResult('object'));
  });

  it('reads each field once, so a getter cannot change the value it returned', () => {
    let reads = 0;
    const shifting = Object.defineProperty({ ...invokeResponse(new Uint8Array()) }, 'function_error', {
      enumerable: true,
      get: (): string | undefined => {
        reads += 1;
        return reads === 1 ? undefined : 'Unhandled';
      },
    });
    const result = transportResultOf(shifting);
    assert.equal(reads, 1);
    assert.equal(result.kind === 'response' ? result.function_error : 'not a response', undefined);
  });

  it('always returns a well-formed settlement (property)', () => {
    const settlement = fc.oneof(
      fc.record({
        kind: fc.constant('response' as const),
        status_code: fc.integer(),
        executed_version: fc.option(fc.string(), { nil: undefined }),
        function_error: fc.option(fc.string(), { nil: undefined }),
        payload: fc.uint8Array({ maxLength: 16 }),
      }),
      fc.record(
        {
          kind: fc.constant('transport_error' as const),
          error_name: fc.string(),
          message: fc.string(),
          http_status: fc.integer(),
        },
        { requiredKeys: ['kind', 'error_name', 'message'] },
      ),
    );
    const anyValue = fc.anything({ withNullPrototype: true, withBigInt: true, withMap: true, withTypedArray: true });
    fc.assert(
      fc.property(fc.oneof(settlement, anyValue), (value) => {
        const result = transportResultOf(value);
        assert.ok(result.kind === 'response' || typeof result.error_name === 'string');
        assert.ok(result.kind === 'transport_error' || result.payload instanceof Uint8Array);
      }),
      fuzzParameters(),
    );
    fc.assert(
      fc.property(settlement, (value) => {
        // fc.record may build a null-prototype object; the copy is a plain one with equal fields.
        assert.deepEqual(transportResultOf(value), { ...value });
      }),
      fuzzParameters(),
    );
  });
});
