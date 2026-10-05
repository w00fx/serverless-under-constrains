// The controller's validation of one inserted `caller_timeout_recorded` (BR-RUA-025 "An
// independent controller validates the caller event"; design §9.11 "invalid event, or identity
// mismatch"). The event must be a version-1 caller timeout of this deployment's execution, of
// the frozen manifest the partition's configuration declares, of the partition's trial (or of
// no trial in the probe and canary partitions), written by the source the partition expects,
// and it must name its attempt. The runner writes the readiness canary (D-10), so a canary
// event comes from the runner and is checked against no configuration.
//
// The check is hand-written and covers only what the controller relies on; the oracle judges
// the remaining fields (for example BR-RUA-011 judges `elapsed_ns` and `arbiter_winner`).

import { isSha256Hex } from '../record-contract/digests.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import type { EventSource } from '../record-contract/envelope.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import { describeJson, isJsonObject } from '../record-contract/json-value.ts';
import type {
  ExecutionIdentity,
  JsonObject,
  JsonValue,
  Result,
  Sha256Hex,
  Uuid4,
} from '../record-contract/primitives.ts';
import type { ConfiguredTrial, ControllerConfigView } from './controller-control-items.ts';

/** The identities of a valid caller timeout. */
export interface CallerTimeoutView {
  readonly event_id: Uuid4;
  readonly attempt_id: Uuid4;
}

/** Why an event cannot be judged, plus the identities that could still be read from it. */
export interface InvalidCallerTimeout {
  readonly detail: string;
  readonly caller_timeout_event_id?: Uuid4;
  readonly attempt_id?: Uuid4;
}

/** What a valid event of one partition must declare. */
export interface CallerTimeoutExpectation {
  readonly deployment: ExecutionIdentity;
  /** The frozen manifest digest; undefined in the canary partition, which has no configuration. */
  readonly execution_manifest_sha256: Sha256Hex | undefined;
  /** The configured trial, or undefined outside trial partitions. */
  readonly trial: ConfiguredTrial | undefined;
  readonly source: EventSource;
}

const IDENTITY_FIELDS = ['run_id', 'variant_validation_id', 'transport_probe_id'] as const;
const RECORD_TYPE = 'caller_timeout_recorded';

/**
 * The expectation of an experiment partition: its configuration's digest, trial and caller.
 *
 * @example
 * experimentExpectation(deployment, config).source; // 'probe_caller' when config.registered_caller_id is 'probe'
 */
export function experimentExpectation(
  deployment: ExecutionIdentity,
  config: ControllerConfigView,
): CallerTimeoutExpectation {
  return {
    deployment,
    execution_manifest_sha256: config.execution_manifest_sha256,
    trial: config.trial,
    source: `${config.registered_caller_id}_caller`,
  };
}

/**
 * The expectation of the readiness canary: written by the runner, in no trial (D-10).
 *
 * @example
 * canaryExpectation(deployment).source; // 'runner'
 */
export function canaryExpectation(deployment: ExecutionIdentity): CallerTimeoutExpectation {
  return { deployment, execution_manifest_sha256: undefined, trial: undefined, source: 'runner' };
}

/**
 * Reads a stream image as a caller timeout of `expected`, or says why it is not one.
 *
 * @example
 * readCallerTimeout(image, experimentExpectation(deployment, config)); // { ok: true, value: { event_id, attempt_id } }
 */
export function readCallerTimeout(
  image: JsonValue,
  expected: CallerTimeoutExpectation,
): Result<CallerTimeoutView, InvalidCallerTimeout> {
  if (!isJsonObject(image)) {
    return invalid(`stream image is ${describeJson(image)}; expected a JSON object`, undefined);
  }
  const problem = firstProblem(image, expected);
  if (problem !== undefined) {
    return invalid(problem, image);
  }
  const eventId = image['event_id'];
  const attemptId = image['attempt_id'];
  if (!isUuid4(eventId) || !isUuid4(attemptId)) {
    return invalid(
      `event_id ${describeJson(eventId)} and attempt_id ${describeJson(attemptId)}; expected lowercase RFC 4122 version-4 UUIDs`,
      image,
    );
  }
  return { ok: true, value: { event_id: eventId, attempt_id: attemptId } };
}

function firstProblem(image: JsonObject, expected: CallerTimeoutExpectation): string | undefined {
  if (image['record_type'] !== RECORD_TYPE || image['schema_version'] !== 1) {
    return `record_type ${describeJson(image['record_type'])} schema_version ${describeJson(image['schema_version'])}; expected ${RECORD_TYPE} version 1`;
  }
  return (
    executionProblem(image, expected.deployment) ??
    manifestProblem(image, expected.execution_manifest_sha256) ??
    trialProblem(image, expected.trial) ??
    sourceProblem(image, expected.source)
  );
}

function executionProblem(image: JsonObject, deployment: ExecutionIdentity): string | undefined {
  const [[field, id] = ['', '']] = Object.entries(executionIdentityFields(deployment));
  const others = IDENTITY_FIELDS.filter((name) => name !== field && Object.hasOwn(image, name));
  if (image[field] === id && others.length === 0) {
    return undefined;
  }
  const declared = IDENTITY_FIELDS.filter((name) => Object.hasOwn(image, name)).map(
    (name) => `${name}=${describeJson(image[name])}`,
  );
  return `execution identity [${declared.join(', ')}]; expected only ${field}=${id}`;
}

function manifestProblem(image: JsonObject, expected: Sha256Hex | undefined): string | undefined {
  const digest = image['execution_manifest_sha256'];
  if (expected === undefined ? isSha256Hex(digest) : digest === expected) {
    return undefined;
  }
  return `execution_manifest_sha256 ${describeJson(digest)}; expected ${expected ?? '64 lowercase hex digits'}`;
}

function trialProblem(image: JsonObject, trial: ConfiguredTrial | undefined): string | undefined {
  const trialId = image['trial_id'];
  const trialDigest = image['trial_manifest_sha256'];
  if (trial === undefined) {
    return trialId === undefined && trialDigest === undefined
      ? undefined
      : `trial_id ${describeJson(trialId)} trial_manifest_sha256 ${describeJson(trialDigest)}; expected no trial identity`;
  }
  if (trialId === trial.trial_id && trialDigest === trial.trial_manifest_sha256) {
    return undefined;
  }
  return `trial_id ${describeJson(trialId)} trial_manifest_sha256 ${describeJson(trialDigest)}; expected trial ${trial.trial_id} with manifest ${trial.trial_manifest_sha256}`;
}

function sourceProblem(image: JsonObject, source: EventSource): string | undefined {
  return image['source'] === source ? undefined : `source ${describeJson(image['source'])}; expected ${source}`;
}

function invalid(detail: string, image: JsonObject | undefined): Result<CallerTimeoutView, InvalidCallerTimeout> {
  const eventId = image?.['event_id'];
  const attemptId = image?.['attempt_id'];
  return {
    ok: false,
    error: {
      detail,
      ...(isUuid4(eventId) ? { caller_timeout_event_id: eventId } : {}),
      ...(isUuid4(attemptId) ? { attempt_id: attemptId } : {}),
    },
  };
}
