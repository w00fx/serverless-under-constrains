// Events built by JournalWriter conform to their catalogue schemas (BR-RUA-033 envelope plus
// the WP-02 group-B record schemas), in every partition kind. Each event goes through the
// serialization kernel to bytes and back before the real Ajv validator reads it, as ingestion
// will. The request-state case also carries the BR-RUA-022 example: a timeout followed by a
// successful retry finishes as FINISHED / SUCCEEDED with knowledge UNKNOWN.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { foldEffectKnowledge } from '../../../src/attempt-lifecycle/effect-knowledge.ts';
import type { AppendResult } from '../../../src/event-journal/journal-append-port.ts';
import type { JournalScope } from '../../../src/event-journal/journal-scope.ts';
import type { EventSource } from '../../../src/record-contract/envelope.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import type { DecimalString, Uuid4, UtcMillis } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import {
  appendedEvent,
  ATTEMPT_ID,
  CAUSE_LOW,
  dispatchStartedBody,
  EPOCH_UTC,
  executionLevelScope,
  MANIFEST_SHA,
  PROBE,
  PROVIDER_REQUEST_ID,
  RUN,
  RUN_ID,
  TRIAL_SCOPE,
  VALIDATION,
  writerHarness,
} from '../../support/event-journal/journal-fixtures.ts';

const validator = createRecordValidator();

function assertSchemaValid(result: AppendResult): void {
  const event = appendedEvent(result);
  const parsed = parseJsonDocument(serializeRecordFile(event));
  assert.ok(parsed.ok);
  const validation = validator.validateAs(event.record_type, parsed.value);
  assert.equal(validation.valid, true, JSON.stringify(validation));
}

function writerFor(scope: JournalScope, source: EventSource): ReturnType<typeof writerHarness>['writer'] {
  return writerHarness({ scope, source }).writer;
}

describe('journal events conform to their record schemas', () => {
  it('trial partition: dispatch_started, attempt_not_dispatched and request_state_recorded', async () => {
    const writer = writerFor(TRIAL_SCOPE, 'conventional_caller');
    assertSchemaValid(await writer.append('dispatch_started', dispatchStartedBody()));
    assertSchemaValid(
      await writer.append('attempt_not_dispatched', {
        attempt_id: ATTEMPT_ID,
        provider_request_id: PROVIDER_REQUEST_ID,
        refund_request_id: 'ref-poc-001',
        failure: {
          code: 'CALL_BUILD_FAILED',
          subject: 'BR-RUA-021',
          detail: 'payload build failed; expected a provider_refund_call',
        },
      }),
    );
    const knowledge = foldEffectKnowledge(['AMBIGUOUS', 'SUCCESS']);
    assert.equal(knowledge, 'UNKNOWN');
    assertSchemaValid(
      await writer.append('request_state_recorded', {
        version: 3,
        effect_knowledge: knowledge,
        attempt_ids: [ATTEMPT_ID],
        processing_state: 'FINISHED',
        processing_terminal_reason: 'SUCCEEDED',
        refund_request_id: 'ref-poc-001',
      }),
    );
  });

  it('probe partition: caller_invocation_started of the probe caller', async () => {
    const writer = writerFor(executionLevelScope(PROBE, 'probe'), 'probe_caller');
    assertSchemaValid(await writer.append('caller_invocation_started', { lambda_request_id: 'request-1' }));
  });

  it('canary partition: controller_canary_acknowledged', async () => {
    const writer = writerFor(executionLevelScope(VALIDATION, 'canary'), 'treatment_controller');
    assertSchemaValid(
      await writer.append('controller_canary_acknowledged', { canary_event_id: CAUSE_LOW }, [CAUSE_LOW]),
    );
  });

  it('warm-up partition: provider_warmup_completed (addendum §2)', async () => {
    const writer = writerFor(executionLevelScope(RUN, 'warmup'), 'refund_provider');
    assertSchemaValid(
      await writer.append('provider_warmup_completed', {
        provider_call_id: 'ffffffff-0000-4000-8000-0000000000aa' as Uuid4,
        warmup_id: 'ffffffff-0000-4000-8000-0000000000bb' as Uuid4,
        received_at: EPOCH_UTC,
        completed_at: '2026-10-05T12:00:00.004Z' as UtcMillis,
        handler_elapsed_ns: '4000000' as DecimalString,
      }),
    );
  });

  it('provider partition: a causal-root provider_call_rejected without trial identity (A-09)', async () => {
    const writer = writerFor(executionLevelScope(RUN, 'provider'), 'refund_provider');
    const appended = await writer.append('provider_call_rejected', {
      provider_call_id: 'ffffffff-0000-4000-8000-0000000000cc' as Uuid4,
      reason: 'SCHEMA_INVALID',
      detail: 'call is "x"; expected a provider_refund_call JSON object',
    });
    assertSchemaValid(appended);
    const event = appendedEvent(appended);
    assert.equal(Object.hasOwn(event, 'trial_id') || Object.hasOwn(event, 'causation_event_ids'), false);
  });

  it('execution-level file journal: lease_event_recorded', async () => {
    const writer = writerFor(executionLevelScope(RUN, 'execution'), 'coordination_lease');
    assertSchemaValid(
      await writer.append('lease_event_recorded', {
        lease_event: 'ACQUIRED',
        owner_kind: 'RUN',
        owner_id: RUN_ID,
        owner_manifest_sha256: MANIFEST_SHA,
        lease_version: 1,
      }),
    );
  });
});
