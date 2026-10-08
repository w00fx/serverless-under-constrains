// A leak audit that throws, as an audit with a bug would: cleanup must record the failure and
// still freeze an `inconclusive` result rather than abandon its remaining steps (BR-RUA-046).

import type { LeakAuditRunner } from '../../../src/cleanup/cleanup-orchestrator.ts';
import type { AuditInput } from '../../../src/cleanup/leak-auditor.ts';
import type { LeakAuditResult } from '../../../src/record-contract/records/group-c/leak_audit_result.ts';

/**
 * A leak audit runner whose every audit rejects with `message`.
 *
 * @example
 * await new ThrowingLeakAuditRunner('boom').audit(input); // rejects with Error('boom')
 */
export class ThrowingLeakAuditRunner implements LeakAuditRunner {
  readonly #message: string;
  #calls = 0;

  constructor(message: string) {
    this.#message = message;
  }

  callCount(): number {
    return this.#calls;
  }

  audit(input: AuditInput): Promise<LeakAuditResult> {
    this.#calls += 1;
    return Promise.reject(new Error(`${this.#message} (execution manifest ${input.execution_manifest_sha256})`));
  }
}
