// The controlled refund provider (BR-RUA-016, BR-RUA-018, the provider half of BR-RUA-025).
// Per call it assigns a fresh `provider_call_id`, reads the partition's frozen configuration,
// the trial payment and the treatment item with consistent reads, records
// `provider_call_received`, and judges the call (design §9.10). A rejected call records
// `provider_call_rejected`, creates no transaction and leaves treatment untouched. An accepted
// call commits exactly one SUCCEEDED ledger transaction; the targeted call then holds its
// response at the treatment barrier, and every other call records `provider_response_returned`.
// Business outcomes are responses and never throw; operational faults throw ProviderFault.

import type { JournalScope } from '../event-journal/journal-scope.ts';
import type { JournalWriter } from '../event-journal/journal-writer.ts';
import type { EventBody } from '../event-journal/journal-event.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import { isJsonObject } from '../record-contract/json-value.ts';
import type {
  ExecutionIdentity,
  JsonValue,
  MonotonicClock,
  Sleeper,
  Uuid4,
  UuidSource,
  WallClock,
} from '../record-contract/primitives.ts';
import type { ProviderRefundResponse } from '../record-contract/records/group-a/provider_refund_response.ts';
import type { ProviderWarmupCompleted } from '../record-contract/records/group-b/provider_warmup_completed.ts';
import type { TreatmentItem } from '../record-contract/records/group-b/treatment_state_snapshot.ts';
import type { EventRecordType } from '../record-contract/record-types.ts';
import type { AcceptanceContext, AcceptanceDecision, AcceptedCall } from './acceptance.ts';
import { evaluateAcceptance } from './acceptance.ts';
import type { ConfirmedCommit } from './commit-execution.ts';
import { executeCommit } from './commit-execution.ts';
import type { ProviderConfigView } from './control-items.ts';
import type { FaultPhase } from './provider-fault.ts';
import { ProviderFault } from './provider-fault.ts';
import type { CallPartition } from './provider-partition.ts';
import { callJournalScope, resolveCallPartition } from './provider-partition.ts';
import type { ProviderStatePort, ProviderStateRead } from './provider-state-port.ts';
import { ProviderWarmup } from './provider-warmup.ts';
import { BARRIER_TIMING, TreatmentBarrier } from './treatment-barrier.ts';
import { describeUntrusted, requestDigest } from './untrusted-json.ts';

export interface RefundProviderDeps {
  /** The execution this deployment belongs to (function environment). */
  readonly deployment: ExecutionIdentity;
  readonly state: ProviderStatePort;
  /** Opens a journal writer with a new source instance; called once per invocation. */
  readonly openJournal: (scope: JournalScope) => JournalWriter;
  readonly ids: UuidSource;
  readonly wall: WallClock;
  readonly monotonic: MonotonicClock;
  readonly sleeper: Sleeper;
}

/** What one invocation returns: a refund response, or the recorded warm-up completion. */
export type ProviderInvocationResult = ProviderRefundResponse | ProviderWarmupCompleted;

/** Everything one call carries from its reads to its decision. */
interface CallSession {
  readonly provider_call_id: Uuid4;
  readonly partition: CallPartition;
  readonly context: AcceptanceContext;
  readonly scenario: ProviderConfigView['scenario'];
  readonly treatment: TreatmentItem | undefined;
  readonly journal: JournalWriter;
  readonly received_event_id: Uuid4;
}

const RECEIVED_COPY_FIELDS = [
  'caller_id',
  'attempt_id',
  'provider_request_id',
  'refund_request_id',
  'payment_id',
] as const;

export class RefundProvider {
  readonly #deps: RefundProviderDeps;
  readonly #warmup: ProviderWarmup;

  constructor(deps: RefundProviderDeps) {
    this.#deps = deps;
    this.#warmup = new ProviderWarmup(deps);
  }

  /**
   * Routes one invocation payload: a `provider_warmup_request` goes to the warm-up, anything
   * else is judged as a refund call.
   *
   * @example
   * const result = await provider.handle(event); // Lambda entry
   */
  handle(raw: JsonValue): Promise<ProviderInvocationResult> {
    if (isJsonObject(raw) && raw['record_type'] === 'provider_warmup_request') {
      return this.#warmup.handle(raw);
    }
    return this.handleCall(raw);
  }

  /**
   * Handles one refund call. Returns SUCCEEDED or REJECTED; throws ProviderFault when the call
   * cannot be attributed, read, committed or recorded.
   *
   * @example
   * const response = await provider.handleCall(call); // { outcome: 'REJECTED', rejection_reason: 'CURRENCY_MISMATCH', ... }
   */
  async handleCall(raw: JsonValue): Promise<ProviderRefundResponse> {
    const session = await this.#openSession(raw, this.#deps.ids.next());
    const decision = evaluateAcceptance(raw, session.context);
    if (!decision.accepted) {
      return this.#reject(session, raw, decision);
    }
    const accepted = await appendOrFault(
      session,
      'provider_call_accepted',
      acceptedBody(session, decision.call),
      'before_commit',
    );
    const targeted = session.scenario === 'COMMIT_THEN_TIMEOUT' && session.treatment?.state === 'ARMED';
    const commit = await executeCommit(
      { ...this.#deps, journal: session.journal },
      {
        partition: session.partition.key,
        call: decision.call,
        provider_call_id: session.provider_call_id,
        accepted_event_id: accepted,
        kind: targeted ? 'targeted' : 'untargeted',
      },
    );
    await this.#finish(session, decision.call, commit);
    return {
      schema_version: 1,
      record_type: 'provider_refund_response',
      outcome: 'SUCCEEDED',
      provider_call_id: session.provider_call_id,
      attempt_id: decision.call.attempt_id,
      provider_request_id: decision.call.provider_request_id,
      provider_transaction_id: commit.plan.ids.provider_transaction_id,
    };
  }

  async #openSession(raw: JsonValue, providerCallId: Uuid4): Promise<CallSession> {
    const partition = resolveCallPartition(this.#deps.deployment, raw);
    if (partition === undefined) {
      const named = isJsonObject(raw)
        ? `trial_id ${describeUntrusted(raw['trial_id'])}`
        : `payload ${describeUntrusted(raw)}`;
      throw new ProviderFault(
        'UNATTRIBUTABLE_CALL',
        'before_commit',
        providerCallId,
        `call names no trial partition (${named}); expected a call object with a lowercase UUIDv4 trial_id`,
      );
    }
    const config = readOrFault(await this.#deps.state.loadTrialConfiguration(partition), providerCallId);
    if (config === undefined) {
      throw new ProviderFault(
        'CONFIGURATION_MISSING',
        'before_commit',
        providerCallId,
        `no provider configuration in partition ${partition.key}; expected the frozen config item`,
      );
    }
    // BR-RUA-016: a trial partition holds exactly one payment, the one its configuration names.
    const payment = readOrFault(await this.#deps.state.loadPayment(partition.key, config.payment_id), providerCallId);
    const treatment = readOrFault(await this.#deps.state.loadTreatment(partition.key), providerCallId);
    const journal = this.#deps.openJournal(callJournalScope(this.#deps.deployment, config));
    const received = await journal.append('provider_call_received', receivedBody(raw, providerCallId));
    if (received.kind === 'stopped') {
      throw journalStopped(providerCallId, 'provider_call_received', received.reason, 'before_commit');
    }
    return {
      provider_call_id: providerCallId,
      partition,
      context: { deployment_execution: this.#deps.deployment, trial_configuration: config, payment },
      scenario: config.scenario,
      treatment,
      journal,
      received_event_id: received.event.event_id,
    };
  }

  async #reject(
    session: CallSession,
    raw: JsonValue,
    decision: Extract<AcceptanceDecision, { readonly accepted: false }>,
  ): Promise<ProviderRefundResponse> {
    await appendOrFault(
      session,
      'provider_call_rejected',
      { provider_call_id: session.provider_call_id, reason: decision.reason, detail: decision.detail },
      'before_commit',
    );
    return {
      schema_version: 1,
      record_type: 'provider_refund_response',
      outcome: 'REJECTED',
      provider_call_id: session.provider_call_id,
      ...echoedIdentities(raw),
      rejection_reason: decision.reason,
    };
  }

  async #finish(session: CallSession, call: AcceptedCall, commit: ConfirmedCommit): Promise<void> {
    const ids = commit.plan.ids;
    if (commit.plan.kind === 'untargeted') {
      const returned = {
        provider_commit_id: ids.provider_commit_id,
        provider_transaction_id: ids.provider_transaction_id,
        provider_call_id: session.provider_call_id,
        attempt_id: call.attempt_id,
        provider_request_id: call.provider_request_id,
      };
      await appendOrFault(session, 'provider_response_returned', returned, 'after_commit', [commit.confirmed_event_id]);
      return;
    }
    const barrier = new TreatmentBarrier({
      ...this.#deps,
      journal: session.journal,
      pollIntervalMs: BARRIER_TIMING.poll_interval_ms,
      safetyReleaseMs: BARRIER_TIMING.safety_release_ms,
    });
    await barrier.awaitRelease({
      partition: session.partition.key,
      provider_commit_id: ids.provider_commit_id,
      provider_call_id: session.provider_call_id,
      attempt_id: call.attempt_id,
      commit_event_id: ids.commit_event_id,
      commit_ack_ns: commit.commit_ack_ns,
    });
  }
}

async function appendOrFault<T extends EventRecordType>(
  session: CallSession,
  type: T,
  body: EventBody<T>,
  phase: FaultPhase,
  causation: readonly Uuid4[] = [session.received_event_id],
): Promise<Uuid4> {
  const appended = await session.journal.append(type, body, causation);
  if (appended.kind === 'stopped') {
    throw journalStopped(session.provider_call_id, type, appended.reason, phase);
  }
  return appended.event.event_id;
}

function readOrFault<T>(read: ProviderStateRead<T>, providerCallId: Uuid4): T | undefined {
  if (!read.ok) {
    throw new ProviderFault(
      'STATE_UNREADABLE',
      'before_commit',
      providerCallId,
      `${read.error.detail}; expected a consistent read of the control item`,
    );
  }
  return read.value;
}

function journalStopped(providerCallId: Uuid4, type: string, reason: string, phase: FaultPhase): ProviderFault {
  return new ProviderFault(
    'JOURNAL_STOPPED',
    phase,
    providerCallId,
    `${type} not recorded (${reason}); expected a writable source instance`,
  );
}

function receivedBody(raw: JsonValue, providerCallId: Uuid4): EventBody<'provider_call_received'> {
  const copied: Partial<Record<(typeof RECEIVED_COPY_FIELDS)[number], string>> = {};
  for (const field of RECEIVED_COPY_FIELDS) {
    const value = isJsonObject(raw) ? raw[field] : undefined;
    if (typeof value === 'string') {
      copied[field] = value;
    }
  }
  // The Lambda Node runtime JSON-parses the Invoke bytes before the handler runs, so the exact
  // request bytes never reach the provider; the digest covers the canonical bytes of the parsed
  // payload and is total over it (requestDigest; WP-07 review round 1, `1e400` and deep nesting).
  return {
    provider_call_id: providerCallId,
    raw_request_sha256: requestDigest(raw),
    ...copied,
  };
}

function acceptedBody(session: CallSession, call: AcceptedCall): EventBody<'provider_call_accepted'> {
  return { provider_call_id: session.provider_call_id, ...call };
}

function echoedIdentities(raw: JsonValue): { readonly attempt_id?: Uuid4; readonly provider_request_id?: Uuid4 } {
  const attemptId = isJsonObject(raw) ? raw['attempt_id'] : undefined;
  const requestId = isJsonObject(raw) ? raw['provider_request_id'] : undefined;
  return {
    ...(isUuid4(attemptId) ? { attempt_id: attemptId } : {}),
    ...(isUuid4(requestId) ? { provider_request_id: requestId } : {}),
  };
}
