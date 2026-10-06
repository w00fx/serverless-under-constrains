// Owner amendment A-05.3 at the provider-response boundary, end to end: a whole attempt through
// ProviderClient whose provider payload carries a non-finite number or an inherited member name
// is FAILED/MALFORMED_RESPONSE, still DISPATCHED, with its outcome journaled (design §9.9
// "payload unparseable, or ids not echoed"). `JSON.parse('1e400')` yields Infinity, and
// `JSON.parse` makes `__proto__` an own key, so both reach the guard exactly as written here.
// Regression (WP-06 review round 2): no test covered either class at this boundary.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProviderRefundCall } from '../../../src/record-contract/records/group-a/provider_refund_call.ts';
import { PROVIDER_REJECTION_REASONS } from '../../../src/record-contract/records/group-a/provider_refund_response.ts';
import {
  clientHarness,
  invokeResponse,
  journalEvents,
  MS,
  onlyEvent,
  PROVIDER_CALL_ID,
  PROVIDER_TRANSACTION_ID,
  settleAttempt,
} from '../../support/provider-client/provider-client-fixtures.ts';
import type { ScriptedResponder } from '../../support/provider-client/scripted-provider-invoker.ts';

const RESPONSE_FIELDS =
  'schema_version, record_type, outcome, provider_call_id, attempt_id, provider_request_id, provider_transaction_id, rejection_reason';

interface PayloadText {
  readonly schemaVersion?: string;
  readonly outcome?: string;
  readonly reason?: string;
  readonly extra?: string;
}

// The payload as raw JSON text echoing the call's ids, so a member can hold text JSON.stringify
// could never write (1e400) or a key an object literal would not make an own property.
function payloadResponder(text: PayloadText): ScriptedResponder {
  return (call: ProviderRefundCall) => {
    const members = [
      `"schema_version":${text.schemaVersion ?? '1'}`,
      '"record_type":"provider_refund_response"',
      `"outcome":${text.outcome ?? '"SUCCEEDED"'}`,
      `"provider_call_id":"${PROVIDER_CALL_ID}"`,
      `"attempt_id":"${call.attempt_id}"`,
      `"provider_request_id":"${call.provider_request_id}"`,
      text.reason === undefined
        ? `"provider_transaction_id":"${PROVIDER_TRANSACTION_ID}"`
        : `"rejection_reason":${text.reason}`,
      ...(text.extra === undefined ? [] : [text.extra]),
    ];
    return invokeResponse(new TextEncoder().encode(`{${members.join(',')}}`));
  };
}

function overflowDetail(pointer: string): string {
  return `payload is not a JSON document (invalid JSON: "number at JSON pointer \\"${pointer}\\" overflows a finite double")`;
}

async function malformedDetail(text: PayloadText): Promise<string> {
  const harness = clientHarness();
  harness.invoker.resolveAfter(100n * MS, payloadResponder(text));
  const report = await settleAttempt(harness);
  assert.equal(report.outcome, 'FAILED');
  assert.equal(report.dispatch_state, 'DISPATCHED');
  assert.equal(report.failure?.code, 'MALFORMED_RESPONSE');
  const outcome = onlyEvent(journalEvents(harness), 'attempt_outcome_recorded');
  assert.equal(report.outcome_event_id, outcome.event_id);
  assert.equal(outcome.outcome === 'FAILED' ? outcome.failure.detail : '', report.failure.detail);
  return report.failure.detail;
}

describe('ProviderClient with hostile payload members (A-05.3)', () => {
  it('the control payload of this file is SUCCEEDED, so each case below changes one member', async () => {
    const harness = clientHarness();
    harness.invoker.resolveAfter(100n * MS, payloadResponder({}));
    assert.equal((await settleAttempt(harness)).outcome, 'SUCCEEDED');
  });

  // The kernel's parseJsonDocument refuses a number that overflows a finite double, naming
  // where it is, so the guard never sees Infinity.
  it('a non-finite schema_version (1e400, -1e400) is MALFORMED_RESPONSE', async () => {
    for (const nonFinite of ['1e400', '-1e400']) {
      assert.equal(await malformedDetail({ schemaVersion: nonFinite }), overflowDetail('/schema_version'));
    }
  });

  it('a non-finite number as the outcome or the rejection reason is MALFORMED_RESPONSE', async () => {
    assert.equal(await malformedDetail({ outcome: '1e400' }), overflowDetail('/outcome'));
    assert.equal(
      await malformedDetail({ outcome: '"REJECTED"', reason: '-1e400' }),
      overflowDetail('/rejection_reason'),
    );
  });

  it('__proto__ and constructor as extra keys are unexpected properties', async () => {
    for (const name of ['__proto__', 'constructor']) {
      assert.equal(
        await malformedDetail({ extra: `"${name}":{"outcome":"SUCCEEDED"}` }),
        `property string "${name}"; expected only ${RESPONSE_FIELDS}`,
      );
    }
  });

  it('toString and constructor as the outcome or the rejection reason are refused', async () => {
    for (const name of ['toString', 'constructor']) {
      assert.equal(
        await malformedDetail({ outcome: `"${name}"` }),
        `outcome string "${name}"; expected "SUCCEEDED" or "REJECTED"`,
      );
      assert.equal(
        await malformedDetail({ outcome: '"REJECTED"', reason: `"${name}"` }),
        `rejection_reason string "${name}"; expected one of ${PROVIDER_REJECTION_REASONS.join(', ')}`,
      );
    }
  });
});
