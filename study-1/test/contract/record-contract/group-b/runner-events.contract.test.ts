// Runner, lease and cleanup journal records (catalogue rows 45-56): provisioning evidence per
// event, the trial lifecycle, settlement outcomes, safety checks and the cleanup ledger
// (BR-RUA-028..031, BR-RUA-046..050).

import { describe, it } from 'node:test';

import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import type { StudyRecord } from '../../../../src/record-contract/records/index.ts';
import * as runner from './examples/runner-examples.ts';
import { assertAccepted, assertForbidden, assertMissing, assertRejected } from './support/group-b-validation.ts';
import { withMember, withValueAt } from './support/json-paths.ts';
import { at, digest, toJson } from './support/record-builders.ts';

function json(record: StudyRecord): JsonObject {
  return toJson(record);
}

describe('AC-RUA-046 provisioning_event_recorded', () => {
  it('verification events carry the inventory digest', () => {
    const verified = json(runner.deployCopyVerified());
    const reverified = withMember(verified, 'provisioning_event', 'PACKAGE_ASSEMBLY_REVERIFIED');
    assertAccepted(reverified, 'PACKAGE_ASSEMBLY_REVERIFIED');
    for (const record of [verified, reverified]) {
      assertMissing(withMember(record, 'inventory_sha256', undefined), 'no inventory', 'inventory_sha256');
    }
  });

  it('the deploy start names the stack and the stack id event names its id', () => {
    assertMissing(withMember(json(runner.deployStarted()), 'stack_name', undefined), 'DEPLOY_STARTED', 'stack_name');
    assertMissing(withMember(json(runner.stackIdRecorded()), 'stack_id', undefined), 'STACK_ID_RECORDED', 'stack_id');
    assertAccepted(withMember(json(runner.stackIdRecorded()), 'provisioning_event', 'DEPLOY_SUCCEEDED'), 'succeeded');
  });

  it('a failed deploy names at least one reason', () => {
    assertRejected(withMember(json(runner.deployFailed()), 'reasons', []), 'DEPLOY_FAILED', '/reasons minItems');
    assertAccepted(withMember(json(runner.deployStarted()), 'reasons', []), 'DEPLOY_STARTED without reasons');
  });
});

describe('AC-RUA-046 trial lifecycle events', () => {
  it('the partition check names each table role once', () => {
    const absent = json(runner.trialPartitionsVerifiedAbsent());
    assertRejected(withMember(absent, 'table_roles', []), 'no roles', '/table_roles minItems');
    assertRejected(withMember(absent, 'table_roles', ['ledger', 'ledger']), 'duplicate', '/table_roles uniqueItems');
    assertRejected(withMember(absent, 'table_roles', ['treatment']), 'unknown role', '/table_roles/0 enum');
  });

  it('arming sets ARMED at a positive version', () => {
    const armed = json(runner.treatmentArmed());
    assertRejected(withMember(armed, 'treatment_state', 'COMMITTED_WAITING'), 'state', '/treatment_state enum');
    assertRejected(withMember(armed, 'treatment_version', 0), 'version 0', '/treatment_version minimum');
  });

  it('the published message keeps the SQS receipt formats', () => {
    const published = json(runner.trialMessagePublished());
    assertRejected(withMember(published, 'variant_id', 'probe'), 'probe variant', '/variant_id enum');
    const md5 = '0123456789ABCDEF0123456789ABCDEF';
    assertRejected(withMember(published, 'md5_of_message_body', md5), 'uppercase md5', '/md5_of_message_body pattern');
    assertRejected(withMember(published, 'sequence_number', '1e3'), 'sequence', '/sequence_number pattern');
  });

  it('a probe workload status is an HTTP status', () => {
    const invoked = json(runner.probeWorkloadInvoked());
    assertRejected(withMember(invoked, 'status_code', 99), 'status 99', '/status_code minimum');
    assertRejected(withMember(invoked, 'status_code', 600), 'status 600', '/status_code maximum');
  });

  it('the frozen evidence index is a package-relative path', () => {
    const frozen = json(runner.trialEvidenceFrozen());
    for (const path of ['/trials/index.json', '../index.json', 'trials//index.json', 'trials\\index.json']) {
      assertRejected(withMember(frozen, 'evidence_index_path', path), path, '/evidence_index_path format');
    }
  });

  it('an interruption names a catalogued cause', () => {
    assertRejected(withMember(json(runner.trialInterrupted()), 'cause', 'CRASH'), 'unknown', '/cause enum');
  });
});

describe('AC-RUA-046 settlement_assessed', () => {
  it('an established settlement has its window and no reasons', () => {
    const established = json(runner.establishedSettlement());
    for (const field of ['window_start', 'established_at', 'rechecked_at']) {
      assertMissing(withMember(established, field, undefined), `without ${field}`, field);
    }
    const reasons = [{ code: 'LATE_ACTIVITY', subject: 'settlement', detail: 'journal grew; expected quiet' }];
    assertRejected(withMember(established, 'reasons', reasons), 'with reasons', '/reasons maxItems');
  });

  it('an unestablished settlement has reasons and no window', () => {
    const notEstablished = json(runner.notEstablishedSettlement());
    assertRejected(withMember(notEstablished, 'reasons', []), 'no reasons', '/reasons minItems');
    for (const field of ['window_start', 'established_at', 'rechecked_at']) {
      assertForbidden(withMember(notEstablished, field, at(1)), `with ${field}`, `/${field}`);
    }
  });

  it('restarts name a catalogued cause', () => {
    const established = json(runner.establishedSettlement());
    assertRejected(withValueAt(established, ['restarts', 0, 'cause'], 'NOISE'), 'cause', '/restarts/0/cause enum');
  });
});

describe('AC-RUA-046 safety_check_recorded', () => {
  it('a conclusive result carries the observed value', () => {
    const within = json(runner.safetyCheckWithinLimits());
    assertMissing(withMember(within, 'observed', undefined), 'within_limits', 'observed');
    const breached = withMember(within, 'result', 'breached');
    assertAccepted(breached, 'breached');
    assertMissing(withMember(breached, 'observed', undefined), 'breached', 'observed');
  });

  it('evidence references are sorted, unique and package-relative', () => {
    const check = json(runner.safetyCheckWithinLimits());
    const first = { artifact_path: 'a/first.json', artifact_sha256: digest('a') };
    const second = { artifact_path: 'b/second.json', artifact_sha256: digest('b') };
    assertAccepted(withMember(check, 'evidence_refs', [first, second]), 'sorted');
    assertRejected(withMember(check, 'evidence_refs', [second, first]), 'unsorted');
    assertRejected(withMember(check, 'evidence_refs', [first, first]), 'duplicate');
    const absolute = { artifact_path: '/a.json', artifact_sha256: digest('a') };
    assertRejected(withMember(check, 'evidence_refs', [absolute]), 'absolute', '/evidence_refs/0/artifact_path format');
  });
});

describe('AC-RUA-046 lease and cleanup events', () => {
  it('a lease holder is a kind and id pair', () => {
    const lease = json(runner.leaseEventRecorded());
    for (const field of ['holder_owner_kind', 'holder_owner_id']) {
      assertRejected(withMember(lease, field, undefined), `without ${field}`, ' dependentRequired');
    }
    assertRejected(withMember(lease, 'owner_kind', 'PROBE'), 'owner kind', '/owner_kind enum');
  });

  it('cleanup steps run 1 to 12', () => {
    const action = json(runner.cleanupStepAction());
    assertAccepted(withMember(action, 'step', 12), 'step 12');
    assertRejected(withMember(action, 'step', 0), 'step 0', '/step minimum');
    assertRejected(withMember(action, 'step', 13), 'step 13', '/step maximum');
  });

  it('a resource is a type and identifier pair, and an ownership basis needs the identifier', () => {
    const resource = json(runner.cleanupResourceAction());
    assertRejected(withMember(resource, 'resource_type', undefined), 'no type', ' dependentRequired');
    const step = json(runner.cleanupStepAction());
    assertRejected(withMember(step, 'resource_type', 'AWS::SQS::Queue'), 'type alone', ' dependentRequired');
    assertRejected(withMember(step, 'ownership_basis', 'ambiguous'), 'basis alone', ' dependentRequired');
    assertRejected(withMember(resource, 'ownership_basis', 'Recorded_Stack'), 'basis casing', '/ownership_basis enum');
  });
});
