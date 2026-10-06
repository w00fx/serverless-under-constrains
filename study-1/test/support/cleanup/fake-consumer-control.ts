// The offline event-source mappings (design §10.4 step 3): `UpdateEventSourceMapping(Enabled=
// false)` moves a mapping to `Disabling`, and it reports `Disabled` after a configurable number
// of state reads, as Lambda does asynchronously.

import type {
  ConsumerControlPort,
  ConsumerDisableRequest,
  ConsumerStateRead,
} from '../../../src/cleanup/cleanup-ports.ts';
import type { RecordingMutationLog } from '../kernel/recording-mutation-log.ts';

interface MappingState {
  state: string;
  readsUntilDisabled: number;
}

/**
 * Event-source mappings that disable after a number of state reads.
 *
 * @example
 * const consumers = new FakeConsumerControl(log);
 * consumers.add('mapping-1', 2);
 * await consumers.requestDisable('mapping-1'); // { kind: 'requested' }
 * await consumers.readState('mapping-1'); // { kind: 'state', state: 'Disabling' }
 * await consumers.readState('mapping-1'); // { kind: 'state', state: 'Disabled' }
 */
export class FakeConsumerControl implements ConsumerControlPort {
  readonly #log: RecordingMutationLog;
  readonly #mappings = new Map<string, MappingState>();
  readonly #requestFailures = new Set<string>();
  readonly #readFailures = new Set<string>();
  readonly #deletedOnRequest = new Set<string>();

  constructor(log: RecordingMutationLog) {
    this.#log = log;
  }

  /** Adds an enabled mapping that reports Disabled on the `readsUntilDisabled`-th read after the request. */
  add(mappingId: string, readsUntilDisabled = 1): void {
    this.#mappings.set(mappingId, { state: 'Enabled', readsUntilDisabled });
  }

  /** Disable requests of this mapping fail. */
  failRequest(mappingId: string): void {
    this.#requestFailures.add(mappingId);
  }

  /** State reads of this mapping fail. */
  failRead(mappingId: string): void {
    this.#readFailures.add(mappingId);
  }

  /** The mapping is deleted (by its stack, say) right after its disable request is accepted. */
  deleteAfterRequest(mappingId: string): void {
    this.#deletedOnRequest.add(mappingId);
  }

  stateOf(mappingId: string): string | undefined {
    return this.#mappings.get(mappingId)?.state;
  }

  requestDisable(mappingId: string): Promise<ConsumerDisableRequest> {
    this.#log.record({ port: 'lambda', operation: 'UpdateEventSourceMapping', target: mappingId });
    if (this.#requestFailures.has(mappingId)) {
      return Promise.resolve({ kind: 'failed', reason: scriptedReason(mappingId, 'disable request') });
    }
    const mapping = this.#mappings.get(mappingId);
    if (mapping === undefined) {
      return Promise.resolve({ kind: 'absent' });
    }
    if (mapping.state === 'Enabled') {
      mapping.state = 'Disabling';
    }
    if (this.#deletedOnRequest.has(mappingId)) {
      this.#mappings.delete(mappingId);
    }
    return Promise.resolve({ kind: 'requested' });
  }

  readState(mappingId: string): Promise<ConsumerStateRead> {
    if (this.#readFailures.has(mappingId)) {
      return Promise.resolve({ kind: 'failed', reason: scriptedReason(mappingId, 'state read') });
    }
    const mapping = this.#mappings.get(mappingId);
    if (mapping === undefined) {
      return Promise.resolve({ kind: 'absent' });
    }
    if (mapping.state === 'Disabling') {
      mapping.readsUntilDisabled -= 1;
      mapping.state = mapping.readsUntilDisabled <= 0 ? 'Disabled' : 'Disabling';
    }
    return Promise.resolve({ kind: 'state', state: mapping.state });
  }
}

function scriptedReason(
  mappingId: string,
  operation: string,
): { readonly code: string; readonly subject: string; readonly detail: string } {
  return { code: 'ServiceException', subject: mappingId, detail: `scripted ${operation} failure; expected success` };
}
