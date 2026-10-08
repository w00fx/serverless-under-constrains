// Phase T6 of the transport probe (design §10.2 P4 for the probe, §9.4; BR-RUA-027, AC-RUA-053):
// the runner's single synchronous `Invoke` of the probe caller's published version, judged.
// - Lambda rejected the Invoke: the probe caller never ran, the probe did not start;
// - Lambda answered with a recordable status and request id: the probe started, and the runner
//   journals `probe_workload_invoked` with the status, the executed version and any function
//   error (AC-RUA-053: the executed version of every runner Invoke is recorded). A non-200
//   status, a function error, another version or a payload that is not this probe's report are
//   diagnostics: the oracle judges the probe from the journals, never from the payload;
// - no response, or one the journal cannot hold (no request id, a status outside 100..599): the
//   probe caller may have run, so the probe started without a recorded invocation (D-29), and the
//   oracle's probe settlement then reports WORKLOAD_INVOCATION_NOT_RECORDED.
// Processing of the probe is terminal once the Invoke returned (settlement-sample.ts); a probe
// whose Invoke never returned can never settle, and freezes indeterminate at the deadline.
//
// Response members are untrusted (Owner amendment A-05): read as own members, parsed strictly,
// quoted through the kernel's bounded renderers, never thrown on.

import type { EventBody } from '../event-journal/journal-event.ts';
import { nonEmptyString, ownValue } from '../evidence-collection/sdk-values.ts';
import { boundedText, describeJson, isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import { classifySendFailure } from './send-failure-classification.ts';
import type { ProbeWorkloadInvokeResult, ProbeWorkloadPlan } from './trial-execution-ports.ts';

const SUBJECT = 'BR-RUA-027';
const INVOKE_OK = 200;
const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;

/** The judged Invoke: the probe did not start, or it started with what the runner records. */
export type ProbeInvocationJudgement =
  | { readonly kind: 'not_started'; readonly reason: StructuredReason }
  | {
      readonly kind: 'started';
      /** The `probe_workload_invoked` body; absent when the Invoke cannot be recorded. */
      readonly invoked?: EventBody<'probe_workload_invoked'>;
      /** Whether the synchronous Invoke returned, which makes the probe's processing terminal. */
      readonly invocation_returned: boolean;
      readonly failures: readonly StructuredReason[];
    };

/** A returned Lambda `Invoke`: its status, executed version, function error, payload and request id. */
export type LambdaInvokeResponse = Extract<ProbeWorkloadInvokeResult, { readonly kind: 'response' }>;

/**
 * The `response` of a returned Lambda `Invoke`, read from the SDK output (`InvokeCommandOutput`)
 * member by member. Total: a member of the wrong type reads as absent, a non-numeric status as 0.
 * The payload is a plain copy, so the SDK's blob adapter never leaks past a port.
 *
 * @example
 * lambdaInvokeResponseOf({ StatusCode: 200, ExecutedVersion: '1', Payload: bytes, $metadata: { requestId: 'r-1' } });
 * // { kind: 'response', status_code: 200, executed_version: '1', payload: bytes, request_id: 'r-1' }
 */
export function lambdaInvokeResponseOf(output: unknown): LambdaInvokeResponse {
  const status = ownMember(output, 'StatusCode');
  const executedVersion = nonEmptyString(ownMember(output, 'ExecutedVersion'));
  const functionError = nonEmptyString(ownMember(output, 'FunctionError'));
  const payload = ownMember(output, 'Payload');
  const requestId = nonEmptyString(ownMember(ownMember(output, '$metadata'), 'requestId'));
  return {
    kind: 'response',
    status_code: typeof status === 'number' ? status : 0,
    ...(executedVersion === undefined ? {} : { executed_version: executedVersion }),
    ...(functionError === undefined ? {} : { function_error: functionError }),
    payload: copiedBytes(payload),
    ...(requestId === undefined ? {} : { request_id: requestId }),
  };
}

/**
 * How a probe caller Invoke that threw settled: `rejected` for a definitive 4xx client fault (the
 * function never ran), otherwise `ambiguous` (send-failure-classification.ts).
 *
 * @example
 * probeInvokeFailureOf(new Error('socket hang up')).kind; // 'ambiguous'
 */
export function probeInvokeFailureOf(thrown: unknown): ProbeWorkloadInvokeResult {
  const failure = classifySendFailure(thrown);
  return failure.kind === 'rejected'
    ? { kind: 'rejected', code: failure.code, detail: failure.detail }
    : { kind: 'ambiguous', code: failure.code, detail: failure.detail };
}

/**
 * Judges how the probe caller's Invoke settled against the probe's plan.
 *
 * @example
 * const judged = judgeProbeInvocation(await invoker.invokeWorkload(plan.request), plan);
 * if (judged.kind === 'started' && judged.invoked !== undefined) journal.record('probe_workload_invoked', judged.invoked);
 */
export function judgeProbeInvocation(
  result: ProbeWorkloadInvokeResult,
  plan: Pick<ProbeWorkloadPlan, 'request' | 'probe_caller_version'>,
): ProbeInvocationJudgement {
  if (result.kind === 'rejected') {
    return {
      kind: 'not_started',
      reason: invocationReason('PROBE_WORKLOAD_NOT_INVOKED', `Lambda rejected the Invoke: ${result.detail}`),
    };
  }
  if (result.kind === 'ambiguous') {
    return unrecorded(false, `the Invoke settled without a response: ${result.detail}`);
  }
  const status = result.status_code;
  const recordable = Number.isInteger(status) && status >= MIN_HTTP_STATUS && status <= MAX_HTTP_STATUS;
  // The journal's lambda_request_id has at least one character; an empty id is no id.
  const requestId = nonEmptyString(result.request_id);
  if (requestId === undefined || !recordable) {
    const described = requestId === undefined ? 'no request id' : 'a request id';
    return unrecorded(true, `the Invoke returned status ${String(status)} with ${described}`);
  }
  const invoked: EventBody<'probe_workload_invoked'> = {
    lambda_request_id: requestId,
    status_code: status,
    ...(result.executed_version === undefined ? {} : { executed_version: result.executed_version }),
    ...(result.function_error === undefined ? {} : { function_error: result.function_error }),
  };
  return { kind: 'started', invoked, invocation_returned: true, failures: responseProblems(result, plan) };
}

function responseProblems(
  result: Extract<ProbeWorkloadInvokeResult, { readonly kind: 'response' }>,
  plan: Pick<ProbeWorkloadPlan, 'request' | 'probe_caller_version'>,
): readonly StructuredReason[] {
  const problems: StructuredReason[] = [];
  if (result.executed_version !== plan.probe_caller_version) {
    const executed =
      result.executed_version === undefined ? 'no version' : `version ${boundedText(result.executed_version)}`;
    problems.push(
      invocationReason(
        'PROBE_WORKLOAD_VERSION_MISMATCH',
        `the Invoke executed ${executed}, not ${plan.probe_caller_version}`,
      ),
    );
  }
  if (result.status_code !== INVOKE_OK || result.function_error !== undefined) {
    const functionError = result.function_error === undefined ? 'none' : boundedText(result.function_error);
    problems.push(
      invocationReason(
        'PROBE_WORKLOAD_FAILED',
        `the Invoke returned status ${String(result.status_code)} with function error ${functionError}`,
      ),
    );
    return problems;
  }
  const report = reportProblem(result.payload, plan.request.transport_probe_id, result.request_id);
  return report === undefined ? problems : [...problems, invocationReason('PROBE_WORKLOAD_REPORT_UNEXPECTED', report)];
}

// The probe caller answers with its ProbeWorkloadReport, which names this probe and the request.
function reportProblem(payload: Uint8Array, probeId: string, requestId: string | undefined): string | undefined {
  const parsed = parseJsonDocument(payload);
  if (!parsed.ok) {
    return `the response payload is not one JSON document (${parsed.error.kind})`;
  }
  const report = parsed.value;
  if (!isJsonObject(report)) {
    return `the response payload is ${describeJson(report)}, not the probe caller's report object`;
  }
  const reported = Object.hasOwn(report, 'transport_probe_id') ? report['transport_probe_id'] : undefined;
  const reportedRequest = Object.hasOwn(report, 'lambda_request_id') ? report['lambda_request_id'] : undefined;
  if (reported !== probeId || reportedRequest !== requestId) {
    return `the report names transport_probe_id ${describeJson(reported)} and lambda_request_id ${describeJson(reportedRequest)}`;
  }
  return undefined;
}

function unrecorded(returned: boolean, problem: string): ProbeInvocationJudgement {
  return {
    kind: 'started',
    invocation_returned: returned,
    failures: [invocationReason('PROBE_WORKLOAD_INVOKE_AMBIGUOUS', problem)],
  };
}

// A copy of a byte payload; anything else, including a value whose prototype cannot be read (a
// proxy whose trap throws, found by the A-05 fuzz target), reads as an empty payload.
function copiedBytes(value: unknown): Uint8Array {
  try {
    return value instanceof Uint8Array ? Uint8Array.from(value) : new Uint8Array();
  } catch {
    return new Uint8Array();
  }
}

// A member that cannot be read (a throwing getter or proxy trap) reads as absent.
function ownMember(holder: unknown, key: string): unknown {
  try {
    return ownValue(holder, key);
  } catch {
    return undefined;
  }
}

function invocationReason(code: string, problem: string): StructuredReason {
  return {
    code,
    subject: SUBJECT,
    detail: `${problem}; expected one recorded Invoke of the probe caller's published version returning its report`,
  };
}
