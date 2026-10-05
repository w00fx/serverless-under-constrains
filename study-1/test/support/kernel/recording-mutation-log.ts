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

export class RecordingMutationLog {
  readonly #records: MutationRecord[] = [];

  record(input: MutationInput): MutationRecord {
    const entry = { ...input, sequence: this.#records.length + 1 };
    this.#records.push(entry);
    return entry;
  }

  entries(): readonly MutationRecord[] {
    return [...this.#records];
  }

  isEmpty(): boolean {
    return this.#records.length === 0;
  }

  /** Sequence number of the first matching mutation, or undefined when none matches. */
  firstSequenceOf(port: string, operation: string): number | undefined {
    return this.#records.find((entry) => entry.port === port && entry.operation === operation)?.sequence;
  }
}
