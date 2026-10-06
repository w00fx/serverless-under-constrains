// Captures what a Lambda entry writes to stdout or stderr (its structured JSON log lines) while
// a test runs, then restores the stream. Used by the handlers' runtime tests; it records the
// text instead of forwarding it, so the test output stays clean.

import type { Writable } from 'node:stream';

export class ProcessStreamCapture {
  readonly #stream: Writable;
  readonly #written: string[] = [];
  #restore: (() => void) | undefined;

  constructor(stream: Writable) {
    this.#stream = stream;
  }

  /** Starts capturing; every later `write` is recorded and not forwarded. */
  start(): void {
    const original = Object.getOwnPropertyDescriptor(this.#stream, 'write');
    const capture = (chunk: unknown): boolean => {
      this.#written.push(String(chunk));
      return true;
    };
    Object.defineProperty(this.#stream, 'write', { value: capture, configurable: true, writable: true });
    this.#restore = (): void => {
      if (original === undefined) {
        Reflect.deleteProperty(this.#stream, 'write');
        return;
      }
      Object.defineProperty(this.#stream, 'write', original);
    };
  }

  /** Stops capturing and restores the stream's own `write`. */
  stop(): void {
    this.#restore?.();
    this.#restore = undefined;
  }

  /** Every captured line parsed as JSON, in order. */
  jsonLines(): readonly unknown[] {
    return this.#written
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as unknown);
  }
}
