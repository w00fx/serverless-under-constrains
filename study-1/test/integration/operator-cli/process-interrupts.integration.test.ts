// The process's SIGINT as the execute commands' interrupt source (design §11): a subscription adds
// one SIGINT listener that each delivered signal calls, and unsubscribing removes exactly it. This
// is also the conformance test of `ManualInterruptSource`: both sources call every subscribed
// listener once per interrupt and none after unsubscribing.

import assert from 'node:assert/strict';
import process from 'node:process';
import { describe, it } from 'node:test';

import type { InterruptSource } from '../../../src/operator-cli/execute-commands.ts';
import { ProcessInterruptSignals } from '../../../src/operator-cli/node/process-interrupts.ts';
import { ManualInterruptSource } from '../../unit/operator-cli/support/manual-interrupt-source.ts';

// Subscribes, delivers two interrupts, unsubscribes and delivers one more.
function exercise(source: InterruptSource, deliver: () => void): number {
  let calls = 0;
  const unsubscribe = source.subscribe(() => {
    calls += 1;
  });
  deliver();
  deliver();
  unsubscribe();
  deliver();
  return calls;
}

describe('ProcessInterruptSignals', () => {
  it('adds and removes exactly one SIGINT listener', () => {
    const before = process.listenerCount('SIGINT');
    const unsubscribe = new ProcessInterruptSignals().subscribe(() => undefined);
    assert.equal(process.listenerCount('SIGINT'), before + 1);
    unsubscribe();
    assert.equal(process.listenerCount('SIGINT'), before);
  });

  it('calls the listener once per SIGINT until unsubscribed, as the manual source does', () => {
    // A guard listener keeps the default SIGINT handler (exit) off while the last signal is delivered.
    const guard = (): void => undefined;
    process.on('SIGINT', guard);
    try {
      const real = exercise(new ProcessInterruptSignals(), () => process.emit('SIGINT'));
      const manual = new ManualInterruptSource();
      const fake = exercise(manual, () => {
        manual.fire();
      });
      assert.equal(real, 2);
      assert.equal(fake, real);
      assert.equal(manual.listening(), 0);
    } finally {
      process.off('SIGINT', guard);
    }
  });
});
