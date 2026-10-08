// Correlation members of untrusted records (BR-RUA-008, BR-RUA-033): only own string members
// count (an inherited name such as `constructor` is never a member, Owner amendment A-05).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  executionIdField,
  executionIdValue,
  hasExecutionId,
  namesOtherExecution,
  ownString,
  partitionOf,
} from '../../../src/evidence-ingestion/record-correlation.ts';
import type { ExecutionIdentity, JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';

const A = '11111111-1111-4111-8111-111111111111' as Uuid4;
const B = '22222222-2222-4222-8222-222222222222' as Uuid4;
const RUN: ExecutionIdentity = { execution_kind: 'RUN', run_id: A };
const PROBE: ExecutionIdentity = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: A };
const VALIDATION: ExecutionIdentity = { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: A };

describe('ownString', () => {
  it('reads an own string member only', () => {
    assert.equal(ownString({ trial_id: 't' }, 'trial_id'), 't');
    assert.equal(ownString({ trial_id: 7 }, 'trial_id'), undefined);
    assert.equal(ownString({}, 'constructor'), undefined);
    assert.equal(ownString({}, 'toString'), undefined);
    assert.equal(ownString(JSON.parse('{"__proto__":"x"}') as JsonValue, '__proto__'), 'x');
    assert.equal(ownString(['trial_id'], '0'), undefined);
    assert.equal(ownString('trial_id', 'length'), undefined);
    assert.equal(ownString(null, 'trial_id'), undefined);
  });
});

describe('execution identity fields', () => {
  it('names the member and id of each execution kind', () => {
    assert.deepEqual([RUN, PROBE, VALIDATION].map(executionIdField), [
      'run_id',
      'transport_probe_id',
      'variant_validation_id',
    ]);
    assert.deepEqual([RUN, PROBE, VALIDATION].map(executionIdValue), [A, A, A]);
  });

  it('detects a record naming another execution, by id or by kind', () => {
    assert.equal(namesOtherExecution({ run_id: A }, RUN), false);
    assert.equal(namesOtherExecution({ run_id: B }, RUN), true);
    assert.equal(namesOtherExecution({ transport_probe_id: A }, RUN), true);
    assert.equal(namesOtherExecution({ run_id: A, variant_validation_id: A }, RUN), true);
    assert.equal(namesOtherExecution({ variant_validation_id: A }, VALIDATION), false);
    assert.equal(namesOtherExecution({}, RUN), false);
    assert.equal(namesOtherExecution({ run_id: 5 }, RUN), false);
  });

  it('treats any execution id member, whatever its value, as present', () => {
    assert.equal(hasExecutionId({ run_id: 7 }), true);
    assert.equal(hasExecutionId({ transport_probe_id: A }), true);
    assert.equal(hasExecutionId({ trial_id: A }), false);
  });
});

describe('partitionOf', () => {
  it('is the trial id or the execution level', () => {
    assert.equal(partitionOf({ trial_id: A }), A);
    assert.equal(partitionOf({}), 'execution');
    assert.equal(partitionOf({ trial_id: 1 }), 'execution');
  });
});
