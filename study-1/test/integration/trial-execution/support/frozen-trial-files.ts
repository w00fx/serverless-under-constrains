// Reads a frozen trial back from the offline cloud's evidence root: its records, its JSONL lines,
// its runner events and its oracle result, as the tests of trial execution assert on them.

import assert from 'node:assert/strict';

import type { UNIT_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../../src/evidence-package/package-layout.ts';
import type { JsonObject, Uuid4 } from '../../../../src/record-contract/primitives.ts';
import type { OfflineCloud } from '../../../support/offline-cloud/offline-cloud.ts';

const decoder = new TextDecoder();

/** The bytes of one trial file; fails the test when the file is absent. */
export function trialFileBytes(cloud: OfflineCloud, trialId: Uuid4, file: keyof typeof UNIT_PATHS): Uint8Array {
  const path = PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: trialId }, file);
  const bytes = cloud.packageFiles().get(path);
  assert.ok(bytes !== undefined, `${path} is frozen`);
  return bytes;
}

/** The single record of a JSON trial file. */
export function trialRecord(cloud: OfflineCloud, trialId: Uuid4, file: keyof typeof UNIT_PATHS): JsonObject {
  return JSON.parse(decoder.decode(trialFileBytes(cloud, trialId, file))) as JsonObject;
}

/** The records of a JSONL trial file, in order. */
export function trialLines(cloud: OfflineCloud, trialId: Uuid4, file: keyof typeof UNIT_PATHS): readonly JsonObject[] {
  return jsonLines(trialFileBytes(cloud, trialId, file));
}

/** The runner events that name `trialId`, in journal order. */
export function runnerEvents(cloud: OfflineCloud, trialId: Uuid4): readonly JsonObject[] {
  const bytes = cloud.packageFiles().get(EXECUTION_PATHS.runnerJournal) ?? new Uint8Array();
  return jsonLines(bytes).filter((event) => event['trial_id'] === trialId);
}

/** A record member as text: a string as is, anything else as its JSON, an absent one as ''. */
export function textField(record: JsonObject, field: string): string {
  const value = Object.hasOwn(record, field) ? record[field] : undefined;
  if (value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The record types of some records, in order. */
export function recordTypes(records: readonly JsonObject[]): readonly string[] {
  return records.map((record) => textField(record, 'record_type'));
}

/** The value of one validity gate of an oracle result. */
export function gateValue(result: JsonObject, gate: string): string | undefined {
  const found = gateRecord(result, gate);
  return found === undefined ? undefined : textField(found, 'value');
}

/** The reason codes of one validity gate of an oracle result, in order. */
export function gateReasonCodes(result: JsonObject, gate: string): readonly string[] {
  const reasons = gateRecord(result, gate)?.['reasons'];
  assert.ok(Array.isArray(reasons), `the ${gate} gate lists its reasons`);
  return (reasons as readonly JsonObject[]).map((reason) => textField(reason, 'code'));
}

/** The outcome of one rule of an oracle result's `rule_results`. */
export function ruleResult(result: JsonObject, ruleId: string): string | undefined {
  const rules = result['rule_results'];
  assert.ok(Array.isArray(rules), 'the oracle result lists its rule results');
  const found = (rules as readonly JsonObject[]).find((candidate) => candidate['rule_id'] === ruleId);
  return found === undefined ? undefined : textField(found, 'result');
}

function gateRecord(result: JsonObject, gate: string): JsonObject | undefined {
  const gates = result['validity_gates'];
  assert.ok(Array.isArray(gates), 'the oracle result lists its validity gates');
  return (gates as readonly JsonObject[]).find((candidate) => candidate['gate'] === gate);
}

function jsonLines(bytes: Uint8Array): readonly JsonObject[] {
  return decoder
    .decode(bytes)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonObject);
}
