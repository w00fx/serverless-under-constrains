// The guard of the runner's single synchronous invocation payload (BR-RUA-027,
// `probe_workload_request`). It accepts exactly what the JSON Schema accepts, plus one check the
// schema cannot state: the request must name this deployment's transport probe. It is
// hand-written so the probe caller compiles no schema at load time (RK-01), and the fuzz suite
// checks it against the Ajv validator differentially. It never throws: a refusal describes the
// offending value with the kernel's bounded, iterative `describeJson` (Owner amendment A-05;
// WP-08 review r1 found the recursive renderer overflowing at 6,174 levels).

import { isSha256Hex } from '../record-contract/digests.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import { boundedJsonText, describeJson, isJsonObject } from '../record-contract/json-value.ts';
import type { ExecutionIdentity, JsonObject, JsonValue, Result } from '../record-contract/primitives.ts';
import type { ProbeWorkloadRequest } from '../record-contract/records/group-a/probe_workload_request.ts';

const RECORD_TYPE = 'probe_workload_request';
const FIELDS = [
  'schema_version',
  'record_type',
  'transport_probe_id',
  'execution_manifest_sha256',
  'payment_id',
  'refund_request_id',
  'amount_minor',
  'currency',
] as const;
// The `_defs` `nonempty_trimmed` pattern; Ajv compiles schema patterns with the `u` flag.
const NONEMPTY_TRIMMED_PATTERN = /^\S(.*\S)?$/u;

/**
 * Reads the invocation payload as this probe's workload request, or names the first violation.
 *
 * @example
 * parseProbeWorkloadRequest(payload, { execution_kind: 'TRANSPORT_PROBE', transport_probe_id });
 * // { ok: true, value: { record_type: 'probe_workload_request', amount_minor: 10000, ... } }
 */
export function parseProbeWorkloadRequest(
  payload: JsonValue,
  deployment: ExecutionIdentity,
): Result<ProbeWorkloadRequest, string> {
  if (!isJsonObject(payload)) {
    return refuse(`payload is ${describeJson(payload)}; expected a ${RECORD_TYPE} object`);
  }
  const problem = shapeProblem(payload) ?? valueProblem(payload);
  if (problem !== undefined) {
    return refuse(problem);
  }
  const probeId = deployment.execution_kind === 'TRANSPORT_PROBE' ? deployment.transport_probe_id : undefined;
  if (payload['transport_probe_id'] !== probeId) {
    return refuse(
      `transport_probe_id ${describeJson(payload['transport_probe_id'])}; expected this deployment's probe ${probeId ?? `(none: ${deployment.execution_kind} deployment)`}`,
    );
  }
  // Every field was checked above; the cast restates it.
  return { ok: true, value: payload as unknown as ProbeWorkloadRequest };
}

function shapeProblem(payload: JsonObject): string | undefined {
  const extra = Object.keys(payload).filter((key) => !(FIELDS as readonly string[]).includes(key));
  if (extra.length > 0) {
    return `unexpected properties ${boundedJsonText(extra)}; expected only ${FIELDS.join(', ')}`;
  }
  const missing = FIELDS.filter((field) => !Object.hasOwn(payload, field));
  return missing.length > 0 ? `missing properties ${JSON.stringify(missing)}` : undefined;
}

function valueProblem(payload: JsonObject): string | undefined {
  const checks: readonly [string, boolean, string][] = [
    ['schema_version', payload['schema_version'] === 1, '1'],
    ['record_type', payload['record_type'] === RECORD_TYPE, RECORD_TYPE],
    ['transport_probe_id', isUuid4(payload['transport_probe_id']), 'a lowercase RFC 4122 version-4 UUID'],
    ['execution_manifest_sha256', isSha256Hex(payload['execution_manifest_sha256']), '64 lowercase hex digits'],
    ['payment_id', isNonEmptyTrimmed(payload['payment_id']), 'a non-empty string without edge whitespace'],
    [
      'refund_request_id',
      isNonEmptyTrimmed(payload['refund_request_id']),
      'a non-empty string without edge whitespace',
    ],
    ['amount_minor', isAmountMinor(payload['amount_minor']), 'a safe integer >= 1'],
    ['currency', payload['currency'] === 'BRL', 'BRL'],
  ];
  const failed = checks.find(([, holds]) => !holds);
  return failed === undefined ? undefined : `${failed[0]} ${describeJson(payload[failed[0]])}; expected ${failed[2]}`;
}

function isNonEmptyTrimmed(value: JsonValue | undefined): boolean {
  return typeof value === 'string' && NONEMPTY_TRIMMED_PATTERN.test(value);
}

function isAmountMinor(value: JsonValue | undefined): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function refuse(problem: string): Result<ProbeWorkloadRequest, string> {
  return { ok: false, error: `probe workload request invalid: ${problem}` };
}
