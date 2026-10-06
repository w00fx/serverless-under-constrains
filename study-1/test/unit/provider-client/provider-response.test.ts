// parseProviderResponse: one case per row of the design §9.9 classification table (BR-RUA-021,
// BR-RUA-053 "both transport-level and function-level errors are parsed explicitly"), with the
// check order function error -> version -> status -> payload -> echo.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { outcomeRecordBody, resolutionFromResponse } from '../../../src/provider-client/attempt-resolution.ts';
import type { ProviderTransportResult } from '../../../src/provider-client/provider-invocation-port.ts';
import type { ExpectedProviderResponse } from '../../../src/provider-client/provider-response.ts';
import {
  boundedDiagnostic,
  parseProviderResponse,
  REQUEST_RESPONSE_STATUS,
  RESPONSE_DIAGNOSTIC_MAX_CHARS,
} from '../../../src/provider-client/provider-response.ts';
import type { DecimalString, JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import {
  FIRST_ATTEMPT_ID,
  FIRST_PROVIDER_REQUEST_ID,
  invokeResponse,
  jsonBytes,
  PROVIDER_CALL_ID,
  PROVIDER_TRANSACTION_ID,
  transportError,
} from '../../support/provider-client/provider-client-fixtures.ts';

const EXPECTED: ExpectedProviderResponse = {
  qualifier: '7',
  attempt_id: FIRST_ATTEMPT_ID,
  provider_request_id: FIRST_PROVIDER_REQUEST_ID,
};
const OTHER_ID = 'ffffffff-0000-4000-8000-0000000000ff' as Uuid4;

const SUCCEEDED_PAYLOAD = {
  schema_version: 1,
  record_type: 'provider_refund_response',
  outcome: 'SUCCEEDED',
  provider_call_id: PROVIDER_CALL_ID,
  attempt_id: FIRST_ATTEMPT_ID,
  provider_request_id: FIRST_PROVIDER_REQUEST_ID,
  provider_transaction_id: PROVIDER_TRANSACTION_ID,
} as const;

const REJECTED_PAYLOAD = {
  schema_version: 1,
  record_type: 'provider_refund_response',
  outcome: 'REJECTED',
  provider_call_id: PROVIDER_CALL_ID,
  attempt_id: FIRST_ATTEMPT_ID,
  provider_request_id: FIRST_PROVIDER_REQUEST_ID,
  rejection_reason: 'CURRENCY_MISMATCH',
} as const;

const { provider_request_id: _notEchoed, ...REJECTED_WITHOUT_ECHO } = REJECTED_PAYLOAD;

function respond(overrides: Partial<Extract<ProviderTransportResult, { kind: 'response' }>>): ProviderTransportResult {
  return { ...invokeResponse(jsonBytes(SUCCEEDED_PAYLOAD)), ...overrides };
}

describe('parseProviderResponse (design §9.9)', () => {
  it('row 1: a well-formed SUCCEEDED from the invoked version is succeeded', () => {
    assert.deepEqual(parseProviderResponse(respond({}), EXPECTED), {
      executed_version: '7',
      kind: 'succeeded',
      provider_call_id: PROVIDER_CALL_ID,
      provider_transaction_id: PROVIDER_TRANSACTION_ID,
    });
  });

  it('row 2: a well-formed REJECTED is rejected with its reason', () => {
    assert.deepEqual(parseProviderResponse(respond({ payload: jsonBytes(REJECTED_PAYLOAD) }), EXPECTED), {
      executed_version: '7',
      kind: 'rejected',
      provider_call_id: PROVIDER_CALL_ID,
      rejection_reason: 'CURRENCY_MISMATCH',
    });
  });

  it('row 3: any non-empty function error is FUNCTION_ERROR, checked before everything else', () => {
    const parsed = parseProviderResponse(respond({ function_error: 'Handled', executed_version: '9' }), EXPECTED);
    assert.deepEqual(parsed, {
      executed_version: '9',
      function_error: 'Handled',
      kind: 'failed',
      failure: {
        code: 'FUNCTION_ERROR',
        subject: 'BR-RUA-053',
        detail: 'function error string "Handled"; expected none',
      },
    });
  });

  it('row 3: an empty function error header counts as none', () => {
    assert.equal(parseProviderResponse(respond({ function_error: '' }), EXPECTED).kind, 'succeeded');
  });

  it('row 4: a mismatched executed version is VERSION_MISMATCH', () => {
    assert.deepEqual(parseProviderResponse(respond({ executed_version: '$LATEST' }), EXPECTED), {
      executed_version: '$LATEST',
      kind: 'failed',
      failure: {
        code: 'VERSION_MISMATCH',
        subject: 'BR-RUA-053',
        detail: 'executed version string "$LATEST"; expected the invoked version string "7"',
      },
    });
  });

  it('row 4: an absent or empty executed version is VERSION_MISMATCH without a diagnostic', () => {
    for (const executed of [undefined, ''] as const) {
      const parsed = parseProviderResponse(respond({ executed_version: executed }), EXPECTED);
      assert.equal(parsed.kind, 'failed');
      assert.equal(parsed.failure.code, 'VERSION_MISMATCH');
      assert.equal('executed_version' in parsed, false);
    }
  });

  it('row 5: a status other than 200 is MALFORMED_RESPONSE', () => {
    assert.equal(REQUEST_RESPONSE_STATUS, 200);
    assert.deepEqual(parseProviderResponse(respond({ status_code: 202 }), EXPECTED), {
      executed_version: '7',
      kind: 'failed',
      failure: { code: 'MALFORMED_RESPONSE', subject: 'BR-RUA-018', detail: 'status 202; expected 200' },
    });
  });

  it('row 5: invalid UTF-8 or JSON is MALFORMED_RESPONSE naming the parse failure', () => {
    const notUtf8 = parseProviderResponse(respond({ payload: Uint8Array.of(0x7b, 0xff) }), EXPECTED);
    assert.deepEqual(notUtf8.kind === 'failed' ? notUtf8.failure : undefined, {
      code: 'MALFORMED_RESPONSE',
      subject: 'BR-RUA-018',
      detail: 'payload is not a JSON document (invalid UTF-8 at byte 1)',
    });
    const notJson = parseProviderResponse(respond({ payload: new TextEncoder().encode('{') }), EXPECTED);
    assert.equal(notJson.kind === 'failed' ? notJson.failure.code : '', 'MALFORMED_RESPONSE');
    assert.match(
      notJson.kind === 'failed' ? notJson.failure.detail : '',
      /^payload is not a JSON document \(invalid JSON: "[^"]+"\)$/u,
    );
  });

  it('row 5: a payload outside the response schema is MALFORMED_RESPONSE with the guard detail', () => {
    const parsed = parseProviderResponse(
      respond({ payload: jsonBytes({ ...SUCCEEDED_PAYLOAD, outcome: 'OK' }) }),
      EXPECTED,
    );
    assert.deepEqual(parsed.kind === 'failed' ? parsed.failure : undefined, {
      code: 'MALFORMED_RESPONSE',
      subject: 'BR-RUA-018',
      detail: 'outcome string "OK"; expected "SUCCEEDED" or "REJECTED"',
    });
  });

  it('row 5: ids that do not echo the request are MALFORMED_RESPONSE, for either outcome', () => {
    const cases = [
      [
        { ...SUCCEEDED_PAYLOAD, attempt_id: OTHER_ID },
        `attempt_id string "${OTHER_ID}"; expected the request's ${FIRST_ATTEMPT_ID}`,
      ],
      [
        { ...SUCCEEDED_PAYLOAD, provider_request_id: OTHER_ID },
        `provider_request_id string "${OTHER_ID}"; expected the request's ${FIRST_PROVIDER_REQUEST_ID}`,
      ],
      [REJECTED_WITHOUT_ECHO, `provider_request_id absent; expected the request's ${FIRST_PROVIDER_REQUEST_ID}`],
    ] as const;
    for (const [payload, detail] of cases) {
      const parsed = parseProviderResponse(respond({ payload: jsonBytes(payload) }), EXPECTED);
      assert.deepEqual(parsed.kind === 'failed' ? parsed.failure : undefined, {
        code: 'MALFORMED_RESPONSE',
        subject: 'BR-RUA-018',
        detail,
      });
    }
  });

  it('row 6: an AbortError the transport won with is ABORTED_WITHOUT_DEADLINE', () => {
    assert.deepEqual(parseProviderResponse(transportError('AbortError', 'Request aborted'), EXPECTED), {
      kind: 'failed',
      failure: {
        code: 'ABORTED_WITHOUT_DEADLINE',
        subject: 'BR-RUA-023',
        detail:
          'transport aborted ("Request aborted") without a deadline timer win; expected an abort only after the timer won',
      },
    });
  });

  it('row 7: every other transport error is TRANSPORT_ERROR with its name and HTTP status', () => {
    assert.deepEqual(parseProviderResponse(transportError('ServiceException', 'internal', 500), EXPECTED), {
      kind: 'failed',
      failure: {
        code: 'TRANSPORT_ERROR',
        subject: 'BR-RUA-053',
        detail: 'transport_error:"ServiceException" (HTTP 500): "internal"; expected a provider response',
      },
    });
    const network = parseProviderResponse(transportError('TimeoutError', 'ETIMEDOUT'), EXPECTED);
    assert.equal(
      network.kind === 'failed' ? network.failure.detail : '',
      'transport_error:"TimeoutError": "ETIMEDOUT"; expected a provider response',
    );
  });
});

// Totality over hostile settlements (design §9.9 "payload unparseable ... FAILED
// (malformed_response)"; testing rule 6). Regression (WP-06 review round 1): a 20 KB payload
// nested 10,000 deep made the parser throw RangeError after the dispatch boundary, and a large
// offending value was copied whole into the outcome's failure detail. Round 2: the raw
// function error and executed version still reached the outcome event unbounded, and the
// A-05.3 classes (100,000 levels, non-finite numbers, inherited member names) had no case here.
describe('parseProviderResponse on hostile settlements', () => {
  // The longest detail repeats two bounded values (a transport error's name and message).
  const MAX_DETAIL_CHARS = 1024;
  // A diagnostic keeps at most RESPONSE_DIAGNOSTIC_MAX_CHARS characters plus the cut marker.
  const MAX_DIAGNOSTIC_CHARS = RESPONSE_DIAGNOSTIC_MAX_CHARS + '…[truncated from 9007199254740991 chars]'.length;
  // Far below the 400 KB item limit (aws-semantics.md), whatever the settlement carried.
  const MAX_OUTCOME_BODY_BYTES = 8 * 1024;
  const CORRELATION = {
    attempt_id: FIRST_ATTEMPT_ID,
    provider_request_id: FIRST_PROVIDER_REQUEST_ID,
    refund_request_id: 'ref-1',
  };

  function failureOf(result: ProviderTransportResult): { readonly code: string; readonly detail: string } {
    const parsed = parseProviderResponse(result, EXPECTED);
    assert.ok(parsed.kind === 'failed', parsed.kind);
    return parsed.failure;
  }

  it('classifies a payload nested 100,000 deep as MALFORMED_RESPONSE', () => {
    const deepArray = new TextEncoder().encode(`${'['.repeat(100_000)}${']'.repeat(100_000)}`);
    assert.deepEqual(failureOf(respond({ payload: deepArray })), {
      code: 'MALFORMED_RESPONSE',
      subject: 'BR-RUA-018',
      detail: `payload array ${'['.repeat(200)}…[truncated]; expected a JSON object`,
    });
    const deepField = new TextEncoder().encode(`{"schema_version":${'['.repeat(100_000)}${']'.repeat(100_000)}}`);
    assert.deepEqual(failureOf(respond({ payload: deepField })), {
      code: 'MALFORMED_RESPONSE',
      subject: 'BR-RUA-018',
      detail: `schema_version array ${'['.repeat(200)}…[truncated]; expected 1`,
    });
  });

  it('quotes at most 200 characters of an offending value in every failure detail (kernel rendering)', () => {
    const huge = 'X'.repeat(500_000);
    // The kernel's boundedJsonText: the first 200 characters of the JSON text, then a marker.
    const cut = `"${'X'.repeat(199)}…[truncated]`;
    assert.equal(
      failureOf(respond({ payload: jsonBytes(huge) })).detail,
      `payload string ${cut}; expected a JSON object`,
    );
    assert.equal(failureOf(respond({ function_error: huge })).detail, `function error string ${cut}; expected none`);
    assert.equal(
      failureOf(respond({ executed_version: huge })).detail,
      `executed version string ${cut}; expected the invoked version string "7"`,
    );
    assert.equal(
      failureOf(
        respond({ payload: jsonBytes({ ...SUCCEEDED_PAYLOAD, attempt_id: OTHER_ID, provider_request_id: huge }) }),
      ).detail,
      `provider_request_id string ${cut}; expected a lowercase UUIDv4`,
    );
    assert.equal(
      failureOf(transportError(huge, huge)).detail,
      `transport_error:${cut}: ${cut}; expected a provider response`,
    );
    assert.equal(
      failureOf(transportError('AbortError', huge)).detail,
      `transport aborted (${cut}) without a deadline timer win; expected an abort only after the timer won`,
    );
  });

  it('classifies non-finite numbers and inherited member names as MALFORMED_RESPONSE (A-05.3)', () => {
    const succeededText = JSON.stringify(SUCCEEDED_PAYLOAD).slice(1, -1);
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    const fields =
      'schema_version, record_type, outcome, provider_call_id, attempt_id, provider_request_id, provider_transaction_id, rejection_reason';
    const cases: readonly (readonly [string, string])[] = [
      [
        `{${succeededText.replace('"schema_version":1', '"schema_version":1e400')}}`,
        'payload is not a JSON document (invalid JSON: "number at JSON pointer \\"/schema_version\\" overflows a finite double")',
      ],
      [
        `{${succeededText.replace('"outcome":"SUCCEEDED"', '"outcome":-1e400')}}`,
        'payload is not a JSON document (invalid JSON: "number at JSON pointer \\"/outcome\\" overflows a finite double")',
      ],
      [
        `{${succeededText},"__proto__":{"outcome":"SUCCEEDED"}}`,
        `property string "__proto__"; expected only ${fields}`,
      ],
      [`{${succeededText},"constructor":{}}`, `property string "constructor"; expected only ${fields}`],
      [
        `{${succeededText.replace('"outcome":"SUCCEEDED"', '"outcome":"toString"')}}`,
        'outcome string "toString"; expected "SUCCEEDED" or "REJECTED"',
      ],
    ];
    for (const [text, expected] of cases) {
      const failure = failureOf(respond({ payload: bytes(text) }));
      assert.equal(failure.code, 'MALFORMED_RESPONSE', text);
      assert.equal(failure.detail, expected);
    }
  });

  it('keeps a diagnostic header verbatim up to its bound, then cuts it and names its length', () => {
    const atBound = 'U'.repeat(RESPONSE_DIAGNOSTIC_MAX_CHARS);
    assert.equal(RESPONSE_DIAGNOSTIC_MAX_CHARS, 1024);
    assert.equal(boundedDiagnostic('Unhandled'), 'Unhandled');
    assert.equal(boundedDiagnostic(atBound), atBound);
    assert.equal(boundedDiagnostic(`${atBound}V`), `${atBound}…[truncated from 1025 chars]`);
    // A cut never splits a surrogate pair: the pair straddling the bound is dropped whole.
    const pair = '\u{1F600}';
    const straddling = `${'U'.repeat(RESPONSE_DIAGNOSTIC_MAX_CHARS - 1)}${pair}`;
    assert.equal(boundedDiagnostic(straddling), `${'U'.repeat(1023)}…[truncated from 1025 chars]`);
    const whole = `${'U'.repeat(RESPONSE_DIAGNOSTIC_MAX_CHARS - 2)}${pair}W`;
    assert.equal(boundedDiagnostic(whole), `${'U'.repeat(1022)}${pair}…[truncated from 1025 chars]`);
    const parsed = parseProviderResponse(respond({ function_error: `${atBound}V`, executed_version: '7' }), EXPECTED);
    assert.equal(parsed.function_error, `${atBound}…[truncated from 1025 chars]`);
    assert.equal(parsed.executed_version, '7');
  });

  it('never throws and bounds its detail over arbitrary payload bytes (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (payload) => {
        const failure = failureOf(respond({ payload }));
        assert.equal(failure.code, 'MALFORMED_RESPONSE');
        assert.ok(failure.detail.length <= MAX_DETAIL_CHARS, failure.detail);
      }),
      fuzzParameters(),
    );
  });

  it('never throws and bounds its detail over arbitrary JSON payloads, deep ones included (property)', () => {
    const encoder = new TextEncoder();
    const payload = fc.oneof(
      (fc.jsonValue({ depthSize: 'xlarge', maxDepth: 50 }) as fc.Arbitrary<JsonValue>).map(jsonBytes),
      fc
        .tuple(fc.constantFrom(...Object.keys(SUCCEEDED_PAYLOAD)), fc.jsonValue() as fc.Arbitrary<JsonValue>)
        .map(([name, value]) => jsonBytes({ ...SUCCEEDED_PAYLOAD, [name]: value })),
      fc
        .tuple(fc.nat({ max: 20_000 }), fc.constantFrom(['[', ']'], ['{"a":', '}']))
        .map(([depth, [open, close]]) => encoder.encode(`${open.repeat(depth)}1${close.repeat(depth)}`)),
    );
    fc.assert(
      fc.property(payload, (bytes) => {
        const parsed = parseProviderResponse(respond({ payload: bytes }), EXPECTED);
        assert.ok(['succeeded', 'rejected', 'failed'].includes(parsed.kind));
        assert.ok(parsed.kind !== 'failed' || parsed.failure.detail.length <= MAX_DETAIL_CHARS);
      }),
      fuzzParameters(),
    );
  });

  it('never throws and bounds its detail, diagnostics and outcome event over arbitrary settlements (property)', () => {
    const text = fc.oneof(fc.string(), fc.string({ unit: 'binary', minLength: 300, maxLength: 2_000 }));
    const settlement = fc.oneof(
      fc.record({
        kind: fc.constant('response' as const),
        status_code: fc.integer(),
        executed_version: fc.option(text, { nil: undefined }),
        function_error: fc.option(text, { nil: undefined }),
        payload: fc.uint8Array({ maxLength: 64 }),
      }),
      fc.record(
        {
          kind: fc.constant('transport_error' as const),
          error_name: text,
          message: text,
          http_status: fc.integer(),
        },
        { requiredKeys: ['kind', 'error_name', 'message'] },
      ),
    );
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(settlement, (result) => {
        const parsed = parseProviderResponse(result, EXPECTED);
        assert.ok(parsed.kind !== 'failed' || parsed.failure.detail.length <= MAX_DETAIL_CHARS, parsed.kind);
        assert.ok((parsed.function_error?.length ?? 0) <= MAX_DIAGNOSTIC_CHARS);
        assert.ok((parsed.executed_version?.length ?? 0) <= MAX_DIAGNOSTIC_CHARS);
        const body = outcomeRecordBody(CORRELATION, resolutionFromResponse(parsed, '1' as DecimalString));
        assert.ok(encoder.encode(JSON.stringify(body)).length <= MAX_OUTCOME_BODY_BYTES);
      }),
      fuzzParameters(),
    );
  });
});
