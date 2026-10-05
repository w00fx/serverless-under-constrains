// The provider warm-up (addendum §2, the D-27 resolution): before each trial's publication, and
// before the probe caller's one invocation, the runner invokes the provider's published version
// once with a `provider_warmup_request`. The provider handles it outside every trial partition,
// in `<execution_id>#warmup`: it assigns a fresh `provider_call_id`, appends
// `provider_warmup_completed` with its timings, and returns that event. It never reads or
// writes payment, ledger, treatment or trial state, never consumes treatment and never creates
// a transaction. A request it cannot accept, or a completion it cannot record, is a fault, so
// the runner sees a failed warm-up and stops the trial before publication.

import type { JournalScope } from '../event-journal/journal-scope.ts';
import type { JournalWriter } from '../event-journal/journal-writer.ts';
import { elapsedNs } from '../record-contract/decimal.ts';
import { isSha256Hex } from '../record-contract/digests.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import { describeJson, isJsonObject } from '../record-contract/json-value.ts';
import type {
  ExecutionIdentity,
  JsonObject,
  JsonValue,
  MonotonicClock,
  Result,
  Sha256Hex,
  Uuid4,
  UuidSource,
  WallClock,
} from '../record-contract/primitives.ts';
import type { ProviderWarmupCompleted } from '../record-contract/records/group-b/provider_warmup_completed.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { describeExecution, parseExecutionIdentityFields, sameExecution } from './execution-identity-fields.ts';
import { ProviderFault } from './provider-fault.ts';
import { warmupJournalScope } from './provider-partition.ts';

/** Every property `provider_warmup_request` declares. */
export const WARMUP_REQUEST_PROPERTIES = [
  'schema_version',
  'record_type',
  'run_id',
  'variant_validation_id',
  'transport_probe_id',
  'execution_manifest_sha256',
  'trial_id',
  'warmup_id',
] as const;

/** A structurally valid warm-up request. */
export interface WarmupRequestView {
  readonly execution: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly warmup_id: Uuid4;
}

export interface ProviderWarmupDeps {
  readonly deployment: ExecutionIdentity;
  readonly openJournal: (scope: JournalScope) => JournalWriter;
  readonly ids: UuidSource;
  readonly wall: WallClock;
  readonly monotonic: MonotonicClock;
}

/**
 * The hand-written guard of `provider_warmup_request`; it accepts exactly what the schema
 * accepts (differential property in `test/fuzz/refund-provider/`).
 *
 * @example
 * const request = guardWarmupRequest(raw);
 * if (!request.ok) throw new Error(request.error);
 */
export function guardWarmupRequest(raw: JsonValue): Result<WarmupRequestView, string> {
  if (!isJsonObject(raw)) {
    return { ok: false, error: `warm-up request is ${describeJson(raw)}; expected a provider_warmup_request object` };
  }
  const problem = warmupFieldProblem(raw);
  if (problem !== undefined) {
    return { ok: false, error: problem };
  }
  const execution = parseExecutionIdentityFields(raw);
  if (!execution.ok) {
    return execution;
  }
  // warmupFieldProblem proved both identities; the casts restate it.
  const digest = raw['execution_manifest_sha256'] as Sha256Hex;
  return {
    ok: true,
    value: { execution: execution.value, execution_manifest_sha256: digest, warmup_id: raw['warmup_id'] as Uuid4 },
  };
}

export class ProviderWarmup {
  readonly #deps: ProviderWarmupDeps;

  constructor(deps: ProviderWarmupDeps) {
    this.#deps = deps;
  }

  /**
   * Handles one warm-up request and returns the recorded completion. Throws a ProviderFault
   * (`WARMUP_REQUEST_INVALID`, `JOURNAL_STOPPED`) when the warm-up cannot be accepted or
   * recorded.
   *
   * @example
   * const completed = await warmup.handle({ schema_version: 1, record_type: 'provider_warmup_request', run_id, execution_manifest_sha256, warmup_id });
   */
  async handle(raw: JsonValue): Promise<ProviderWarmupCompleted> {
    const receivedNs = this.#deps.monotonic.nowNs();
    const receivedAt = formatUtcMillis(this.#deps.wall.now());
    const providerCallId = this.#deps.ids.next();
    const request = this.#acceptedRequest(raw, providerCallId);
    const journal = this.#deps.openJournal(
      warmupJournalScope(this.#deps.deployment, request.execution_manifest_sha256),
    );
    const appended = await journal.append('provider_warmup_completed', {
      provider_call_id: providerCallId,
      warmup_id: request.warmup_id,
      received_at: receivedAt,
      completed_at: formatUtcMillis(this.#deps.wall.now()),
      handler_elapsed_ns: elapsedNs(receivedNs, this.#deps.monotonic.nowNs()),
    });
    if (appended.kind === 'stopped') {
      throw new ProviderFault(
        'JOURNAL_STOPPED',
        'before_commit',
        providerCallId,
        `provider_warmup_completed not recorded (${appended.reason}); expected a writable source instance`,
      );
    }
    // The appended event is the warm-up completion; the casts narrow the journal union.
    return appended.event as ProviderWarmupCompleted;
  }

  #acceptedRequest(raw: JsonValue, providerCallId: Uuid4): WarmupRequestView {
    const request = guardWarmupRequest(raw);
    if (!request.ok) {
      throw new ProviderFault('WARMUP_REQUEST_INVALID', 'before_commit', providerCallId, request.error);
    }
    if (!sameExecution(request.value.execution, this.#deps.deployment)) {
      const detail = `warm-up for ${describeExecution(request.value.execution)}; expected the deployment execution ${describeExecution(this.#deps.deployment)}`;
      throw new ProviderFault('WARMUP_REQUEST_INVALID', 'before_commit', providerCallId, detail);
    }
    return request.value;
  }
}

function warmupFieldProblem(raw: JsonObject): string | undefined {
  const unknown = Object.keys(raw).find((key) => !(WARMUP_REQUEST_PROPERTIES as readonly string[]).includes(key));
  if (unknown !== undefined) {
    return `property ${JSON.stringify(unknown)} is not part of provider_warmup_request; expected only ${WARMUP_REQUEST_PROPERTIES.join(', ')}`;
  }
  if (raw['schema_version'] !== 1) {
    return `schema_version is ${describeJson(raw['schema_version'])}; expected the number 1`;
  }
  if (raw['record_type'] !== 'provider_warmup_request') {
    return `record_type is ${describeJson(raw['record_type'])}; expected "provider_warmup_request"`;
  }
  if (!isSha256Hex(raw['execution_manifest_sha256'])) {
    return `execution_manifest_sha256 is ${describeJson(raw['execution_manifest_sha256'])}; expected 64 lowercase hex digits`;
  }
  if (!isUuid4(raw['warmup_id'])) {
    return `warmup_id is ${describeJson(raw['warmup_id'])}; expected a lowercase RFC 4122 version-4 UUID`;
  }
  if (Object.hasOwn(raw, 'trial_id') && !isUuid4(raw['trial_id'])) {
    return `trial_id is ${describeJson(raw['trial_id'])}; expected a lowercase RFC 4122 version-4 UUID when present`;
  }
  return undefined;
}
