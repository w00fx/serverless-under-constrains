// One ordered log of every mutating call made through the fake AWS ports (design §12.2).
// Fakes append to a shared instance, so a test can prove ordering across ports, for example
// that the execution manifest is frozen before the first cloud mutation (AC-RUA-008) or that
// a rejected admission mutated nothing (AC-RUA-014).

import type { JsonValue } from '../../../src/record-contract/primitives.ts';

export interface MutationRecord {
  readonly sequence: number;
  readonly port: string;
  readonly operation: string;
  readonly target: string;
  readonly detail?: JsonValue;
}

export type MutationInput = Omit<MutationRecord, 'sequence'>;

/**
 * One ordered log shared by every fake AWS port; each mutating call appends one entry.
 *
 * @example
 * const log = new RecordingMutationLog();
 * log.record({ port: 'item-store', operation: 'PutItem', target: 'journal' });
 * log.firstSequenceOf('item-store', 'PutItem'); // 1
 */
export class RecordingMutationLog {
  readonly #records: MutationRecord[] = [];

  /** Appends one mutation and returns it with its 1-based sequence number. */
  record(input: MutationInput): MutationRecord {
    const entry = { ...input, sequence: this.#records.length + 1 };
    this.#records.push(entry);
    return entry;
  }

  /** A copy of every mutation in call order. */
  entries(): readonly MutationRecord[] {
    return [...this.#records];
  }

  /** True when no fake port mutated anything (AC-RUA-014). */
  isEmpty(): boolean {
    return this.#records.length === 0;
  }

  /** Sequence number of the first matching mutation, or undefined when none matches. */
  firstSequenceOf(port: string, operation: string): number | undefined {
    return this.#records.find((entry) => entry.port === port && entry.operation === operation)?.sequence;
  }
}
