// Trial identity per record type (BR-RUA-033, design §6.2): the trial id and the trial
// manifest digest travel together; some records exist only inside a trial, some only at the
// execution level, the rest at either. The warm-up request may name a trial for correlation
// but never carries a trial digest (addendum §3).

import { describe, it } from 'node:test';

import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import { RECORD_TYPE_GROUPS } from '../../../../src/record-contract/record-types.ts';
import type { GroupBRecordType } from '../../../../src/record-contract/records/group-b/record-map.ts';
import { CANONICAL_EXAMPLES } from './examples/group-b-examples.ts';
import {
  assertAccepted,
  assertForbidden,
  assertMissing,
  assertRejected,
} from '../../../support/record-contract/group-b-validation.ts';
import { withMember, withoutMembers } from '../../../support/record-contract/json-paths.ts';
import {
  TRIAL_ID,
  TRIAL_MANIFEST_SHA256,
  TRIAL_SCOPE,
  toJson,
} from '../../../support/record-contract/record-builders.ts';

const TRIAL_REQUIRED: readonly GroupBRecordType[] = [
  'trial_message_published',
  'queue_observation',
  'dlq_snapshot',
  'durable_execution_metadata',
];

const EXECUTION_ONLY: readonly GroupBRecordType[] = [
  'provider_warmup_completed',
  'controller_canary_acknowledged',
  'phase_transition_recorded',
  'provisioning_event_recorded',
  'probe_workload_invoked',
  'lease_event_recorded',
  'cleanup_action_recorded',
  'pre_cleanup_snapshot',
  'coordination_prefix_checkpoint',
];

const TRIAL_FIELDS = ['trial_id', 'trial_manifest_sha256'];

const EITHER_SCOPE = RECORD_TYPE_GROUPS['group-b'].filter(
  (recordType) =>
    !TRIAL_REQUIRED.includes(recordType) &&
    !EXECUTION_ONLY.includes(recordType) &&
    recordType !== 'provider_warmup_request',
);

function canonical(recordType: GroupBRecordType): JsonObject {
  return toJson(CANONICAL_EXAMPLES[recordType]());
}

describe('AC-RUA-046 trial scope of group-B records', () => {
  it('trial-only records require both trial fields', () => {
    for (const recordType of TRIAL_REQUIRED) {
      const record = canonical(recordType);
      assertAccepted(record, recordType);
      assertMissing(withoutMembers(record, TRIAL_FIELDS), `${recordType} without trial`, 'trial_id');
      assertMissing(withoutMembers(record, TRIAL_FIELDS), `${recordType} without trial`, 'trial_manifest_sha256');
    }
  });

  it('execution-level records forbid either trial field', () => {
    for (const recordType of EXECUTION_ONLY) {
      const record = withoutMembers(canonical(recordType), TRIAL_FIELDS);
      assertAccepted(record, recordType);
      assertForbidden({ ...record, ...TRIAL_SCOPE }, `${recordType} with trial`, '/trial_id');
      assertForbidden({ ...record, ...TRIAL_SCOPE }, `${recordType} with trial`, '/trial_manifest_sha256');
    }
  });

  it('records of either scope take both trial fields or neither', () => {
    for (const recordType of EITHER_SCOPE) {
      const execution = withoutMembers(canonical(recordType), TRIAL_FIELDS);
      assertAccepted(execution, `${recordType} at execution level`);
      assertAccepted({ ...execution, ...TRIAL_SCOPE }, `${recordType} in a trial`);
      assertRejected(
        withMember(execution, 'trial_id', TRIAL_ID),
        `${recordType} with trial_id alone`,
        ' dependentRequired',
      );
      assertRejected(
        withMember(execution, 'trial_manifest_sha256', TRIAL_MANIFEST_SHA256),
        `${recordType} with the digest alone`,
        ' dependentRequired',
      );
    }
  });

  it('the warm-up request may name a trial but never carries its digest', () => {
    const request = canonical('provider_warmup_request');
    assertAccepted(request, 'warm-up request with trial_id');
    assertAccepted(withMember(request, 'trial_id', undefined), 'warm-up request without trial_id');
    assertForbidden({ ...request, ...TRIAL_SCOPE }, 'warm-up request with digest', '/trial_manifest_sha256');
  });
});
