// AC-RUA-046 (group B): the closed value lists the spec states are the lists the schemas
// enforce. The expectations are copied from the spec text, never from `vocabulary.ts`, so a value
// dropped from both the production tuple and the schema still fails here. For each value the
// test also proves a record carrying it validates: some group-B example of the record type,
// with that value written at the enum site, is accepted.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isJsonArray, isJsonObject } from '../../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { GroupBRecordType } from '../../../../src/record-contract/records/group-b/record-map.ts';
import { GROUP_B_EXAMPLES } from './examples/group-b-examples.ts';
import { assertRejected, violationsOf } from './support/group-b-validation.ts';
import { pointerOf, withValueAt } from './support/json-paths.ts';
import type { JsonPath } from './support/json-paths.ts';
import { toJson } from './support/record-builders.ts';
import { resolvePointer, schemaOf } from './support/schema-reading.ts';

// BR-RUA-021: "Attempt outcomes: SUCCEEDED | REJECTED | TIMED_OUT | FAILED".
const SPEC_ATTEMPT_OUTCOMES = ['SUCCEEDED', 'REJECTED', 'TIMED_OUT', 'FAILED'];
// BR-RUA-021: "Dispatch state: NOT_DISPATCHED | DISPATCHED | UNKNOWN".
const SPEC_DISPATCH_STATES = ['NOT_DISPATCHED', 'DISPATCHED', 'UNKNOWN'];
// BR-RUA-022: "Request processing state: NOT_STARTED | RUNNING | FINISHED".
const SPEC_PROCESSING_STATES = ['NOT_STARTED', 'RUNNING', 'FINISHED'];
// BR-RUA-022: "Request terminal reason: SUCCEEDED | RETRIES_EXHAUSTED | MESSAGE_REJECTED |
// PROVIDER_REJECTED | INTERRUPTED | SAFETY_DEADLINE".
const SPEC_TERMINAL_REASONS = [
  'SUCCEEDED',
  'RETRIES_EXHAUSTED',
  'MESSAGE_REJECTED',
  'PROVIDER_REJECTED',
  'INTERRUPTED',
  'SAFETY_DEADLINE',
];
// BR-RUA-022: "Effect knowledge: NOT_ATTEMPTED | NO_EFFECT_CONFIRMED | ONE_EFFECT_CONFIRMED |
// MULTIPLE_EFFECTS_CONFIRMED | UNKNOWN".
const SPEC_EFFECT_KNOWLEDGE = [
  'NOT_ATTEMPTED',
  'NO_EFFECT_CONFIRMED',
  'ONE_EFFECT_CONFIRMED',
  'MULTIPLE_EFFECTS_CONFIRMED',
  'UNKNOWN',
];
// BR-RUA-025: "Treatment state: ARMED -> COMMITTED_WAITING -> TIMEOUT_SIGNALLED ->
// TIMEOUT_OBSERVED -> RESPONSE_RELEASED", and "A safety release from any nonterminal wait
// records SAFETY_RELEASED".
const SPEC_TREATMENT_STATES = [
  'ARMED',
  'COMMITTED_WAITING',
  'TIMEOUT_SIGNALLED',
  'TIMEOUT_OBSERVED',
  'RESPONSE_RELEASED',
  'SAFETY_RELEASED',
];
// BR-RUA-025: the waits a safety release leaves are the states that are not terminal; the two
// terminals are the end of the chain (RESPONSE_RELEASED) and the release itself.
const SPEC_NONTERMINAL_TREATMENT_STATES = SPEC_TREATMENT_STATES.filter(
  (state) => state !== 'RESPONSE_RELEASED' && state !== 'SAFETY_RELEASED',
);
// BR-RUA-046: "Safety status: within_limits | breached | unverified".
const SPEC_SAFETY_STATUSES = ['within_limits', 'breached', 'unverified'];

interface EnumSite {
  readonly rule: string;
  readonly values: readonly string[];
  readonly recordType: GroupBRecordType;
  /** Where the schema states the enum. */
  readonly schemaPointer: string;
  /** Where a record carries the value; `*` stands for every array index. */
  readonly recordPattern: string;
}

// Every group-B schema location that enforces a full spec list.
const FULL_LIST_SITES: readonly EnumSite[] = [
  site('BR-RUA-021', SPEC_ATTEMPT_OUTCOMES, 'attempt_outcome_recorded', 'outcome'),
  site('BR-RUA-021', SPEC_DISPATCH_STATES, 'attempt_outcome_recorded', 'dispatch_state'),
  site('BR-RUA-022', SPEC_PROCESSING_STATES, 'request_state_recorded', 'processing_state'),
  site('BR-RUA-022', SPEC_TERMINAL_REASONS, 'request_state_recorded', 'processing_terminal_reason'),
  site('BR-RUA-022', SPEC_EFFECT_KNOWLEDGE, 'request_state_recorded', 'effect_knowledge'),
  site('BR-RUA-025', SPEC_TREATMENT_STATES, 'caller_timeout_rejected', 'treatment_state'),
  {
    rule: 'BR-RUA-025',
    values: SPEC_TREATMENT_STATES,
    recordType: 'treatment_state_snapshot',
    schemaPointer: '/$defs/treatment_item/properties/state/enum',
    recordPattern: '/treatment/state',
  },
  {
    rule: 'BR-RUA-025',
    values: SPEC_TREATMENT_STATES,
    recordType: 'pre_cleanup_snapshot',
    schemaPointer: '/$defs/treatment_read/properties/state/enum',
    recordPattern: '/treatment_states/*/state',
  },
  site('BR-RUA-025', SPEC_NONTERMINAL_TREATMENT_STATES, 'treatment_safety_released', 'from_state'),
  site('BR-RUA-046', SPEC_SAFETY_STATUSES, 'safety_check_recorded', 'result'),
];

// Sites that admit only part of the treatment chain (design §9.11 rows); each part must stay
// inside the spec's list.
const TREATMENT_SUBSET_SITES: readonly (readonly [GroupBRecordType, string])[] = [
  ['treatment_armed', '/properties/treatment_state/enum'],
  ['timeout_signal_duplicate_observed', '/properties/treatment_state/enum'],
  ['timeout_signal_conflict_recorded', '/properties/treatment_state/enum'],
  ['late_timeout_signal_rejected', '/properties/treatment_state/enum'],
];

function site(rule: string, values: readonly string[], recordType: GroupBRecordType, property: string): EnumSite {
  return {
    rule,
    values,
    recordType,
    schemaPointer: `/properties/${property}/enum`,
    recordPattern: `/${property}`,
  };
}

/** Every concrete path in `json` that a `/a/*\/b` pattern names. */
function pathsMatching(json: JsonValue, pattern: string): readonly JsonPath[] {
  const expand = (node: JsonValue, segments: readonly string[], path: JsonPath): readonly JsonPath[] => {
    const [head, ...rest] = segments;
    if (head === undefined) {
      return [path];
    }
    if (head === '*') {
      return isJsonArray(node) ? node.flatMap((child, index) => expand(child, rest, [...path, index])) : [];
    }
    const child = isJsonObject(node) ? node[head] : undefined;
    return child === undefined ? [] : expand(child, rest, [...path, head]);
  };
  return expand(json, pattern.split('/').slice(1), []);
}

/** The value in the other case (BR-RUA-033 fixes the case of each list, so a flip is foreign). */
function caseFlipped(value: string): string {
  return value === value.toUpperCase() ? value.toLowerCase() : value.toUpperCase();
}

function examplesOf(recordType: GroupBRecordType): readonly JsonObject[] {
  return GROUP_B_EXAMPLES.filter((example) => example.record.record_type === recordType).map((example) =>
    toJson(example.record),
  );
}

/** The example records of the type that stay valid with `value` written at the enum site. */
function acceptingRecords(enumSite: EnumSite, value: string): readonly string[] {
  return examplesOf(enumSite.recordType).flatMap((json) =>
    pathsMatching(json, enumSite.recordPattern)
      .map((path) => withValueAt(json, path, value))
      .filter((record) => violationsOf(record).length === 0)
      .map((record) => JSON.stringify(record)),
  );
}

describe('AC-RUA-046 group-B enums hold the spec value lists', () => {
  it('every full-list site states exactly the spec list, in the spec order', () => {
    for (const enumSite of FULL_LIST_SITES) {
      assert.deepEqual(
        resolvePointer(schemaOf(enumSite.recordType), enumSite.schemaPointer),
        [...enumSite.values],
        `${enumSite.rule} ${enumSite.recordType}#${enumSite.schemaPointer}`,
      );
    }
  });

  it('a record carrying each spec value validates', () => {
    let checked = 0;
    for (const enumSite of FULL_LIST_SITES) {
      for (const value of enumSite.values) {
        const label = `${enumSite.rule} ${enumSite.recordType}${enumSite.recordPattern} = ${value}`;
        assert.notDeepEqual(acceptingRecords(enumSite, value), [], `${label}: expected some example to accept it`);
        checked += 1;
      }
    }
    assert.equal(checked, 46);
  });

  it('a value outside each spec list is rejected at the site', () => {
    for (const enumSite of FULL_LIST_SITES) {
      const [json] = examplesOf(enumSite.recordType);
      assert.ok(json !== undefined, `${enumSite.recordType} has an example`);
      const [path] = pathsMatching(json, enumSite.recordPattern);
      assert.ok(path !== undefined, `${enumSite.recordType} example carries ${enumSite.recordPattern}`);
      for (const value of [...enumSite.values.map(caseFlipped), 'NOT_IN_SPEC', 'not_in_spec']) {
        assertRejected(withValueAt(json, path, value), `${enumSite.recordType} ${value}`, `${pointerOf(path)} enum`);
      }
    }
  });

  it('partial treatment-state sites stay inside the BR-RUA-025 chain', () => {
    for (const [recordType, pointer] of TREATMENT_SUBSET_SITES) {
      const values = resolvePointer(schemaOf(recordType), pointer);
      assert.ok(isJsonArray(values) && values.length > 0, `${recordType}#${pointer} is an enum`);
      for (const value of values) {
        const known = typeof value === 'string' && SPEC_TREATMENT_STATES.includes(value);
        assert.ok(known, `${recordType} ${JSON.stringify(value)}`);
      }
    }
  });

  it('BR-RUA-021: SUCCEEDED, REJECTED and TIMED_OUT imply DISPATCHED; FAILED may carry any dispatch state', () => {
    const outcomes = examplesOf('attempt_outcome_recorded');
    for (const outcome of SPEC_ATTEMPT_OUTCOMES) {
      const carrier = outcomes.find((json) => json['outcome'] === outcome);
      assert.ok(carrier !== undefined, `an example records ${outcome}`);
      for (const state of SPEC_DISPATCH_STATES) {
        const record: JsonObject = { ...carrier, dispatch_state: state };
        const accepted: boolean = violationsOf(record).length === 0;
        const expected = outcome === 'FAILED' || state === 'DISPATCHED';
        assert.equal(accepted, expected, `${outcome} with ${state}`);
      }
    }
  });
});
