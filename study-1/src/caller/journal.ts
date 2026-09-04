import type { PrimaryEvent } from "../protocol-records/types.ts";
import type { CallerJournal, JournalAppendResult } from "./types.ts";

/**
 * In-memory caller journal with serialized appends, dense sequences, and a
 * stopped source instance after an ambiguous write.
 *
 * @example
 * const journal = new InMemoryCallerJournal();
 * journal.append(opened);
 */
export class InMemoryCallerJournal implements CallerJournal {
  readonly #events = new Map<string, PrimaryEvent>();
  readonly #sequences = new Map<string, number>();
  readonly #stopped = new Set<string>();
  #failRemaining = 0;
  #ambiguousNext = false;
  #skip = 0;

  failNext(times = 1): void {
    this.#failRemaining = times;
  }

  ambiguousNext(): void {
    this.#ambiguousNext = true;
  }

  skipNext(count = 1): void {
    this.#skip = count;
  }

  isStopped(sourceInstanceId: string): boolean {
    return this.#stopped.has(sourceInstanceId);
  }

  peekSequence(sourceInstanceId: string): number {
    return (this.#sequences.get(sourceInstanceId) ?? 0) + 1;
  }

  list(): PrimaryEvent[] {
    return [...this.#events.values()].toSorted(compareEvents);
  }

  append(event: PrimaryEvent): JournalAppendResult {
    if (this.#stopped.has(event.source_instance_id)) {
      return "failed";
    }
    const skip = this.#skip > 0;
    if (skip) {
      this.#skip -= 1;
    } else if (this.#failRemaining > 0) {
      this.#failRemaining -= 1;
      return "failed";
    } else if (this.#ambiguousNext) {
      this.#ambiguousNext = false;
      this.#stopped.add(event.source_instance_id);
      return "ambiguous";
    }
    this.#events.set(event.event_id, event);
    this.#sequences.set(event.source_instance_id, event.source_sequence);
    return "committed";
  }

  appendConditional(
    event: PrimaryEvent,
    predicate: (events: readonly PrimaryEvent[]) => boolean,
  ): JournalAppendResult {
    if (!predicate(this.list())) {
      return "failed";
    }
    return this.append(event);
  }
}

function compareEvents(left: PrimaryEvent, right: PrimaryEvent): number {
  if (left.source_instance_id !== right.source_instance_id) {
    return left.source_instance_id < right.source_instance_id ? -1 : 1;
  }
  return left.source_sequence - right.source_sequence;
}
