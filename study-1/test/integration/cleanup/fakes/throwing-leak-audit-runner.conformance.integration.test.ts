// Conformance of ThrowingLeakAuditRunner: it stands for a LeakAuditRunner whose audit rejects,
// every time, with an Error naming the audited manifest, and counts its calls.
//
// Sources (RK-17): no AWS service is emulated; the contract is the project's LeakAuditRunner,
// standing in for an audit that rejects so the orchestrator's not-audited path is exercised.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION, MANIFEST_SHA, ownershipContext } from '../../../support/cleanup/cleanup-fixtures.ts';
import { ThrowingLeakAuditRunner } from '../../../support/cleanup/throwing-leak-audit-runner.ts';

describe('ThrowingLeakAuditRunner conformance', () => {
  it('rejects every audit with an Error and counts the calls', async () => {
    const runner = new ThrowingLeakAuditRunner('audit bug');
    const input = { execution: EXECUTION, execution_manifest_sha256: MANIFEST_SHA, ownership: ownershipContext() };
    for (let call = 1; call <= 2; call += 1) {
      await assert.rejects(
        runner.audit(input),
        (error: unknown) => error instanceof Error && error.message.startsWith('audit bug (execution manifest aaaa'),
      );
      assert.equal(runner.callCount(), call);
    }
  });
});
