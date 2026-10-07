// How an amendment-writing command reports (design §7, §11; BR-RUA-043): the written path is the
// amendment index; a refusal is exit 5 unless one of its reasons says the amendment chain could not
// be read or stored, which is exit 10.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { amendmentRefusal, amendmentWrittenPath } from '../../../src/operator-cli/amendment-report.ts';
import type { ExecutionIdentity, Uuid4 } from '../../../src/record-contract/primitives.ts';

const EXECUTION: ExecutionIdentity = { execution_kind: 'RUN', run_id: 'b42ee7a8-4b45-43d7-8ca3-cb72ceae84c4' as Uuid4 };

function reason(code: string): { code: string; subject: string; detail: string } {
  return { code, subject: 'BR-RUA-043', detail: `${code} detail` };
}

describe('amendment reports', () => {
  it('names the amendment index as the written path', () => {
    assert.equal(amendmentWrittenPath('amendments/x/0001-a'), 'amendments/x/0001-a/amendment-index.json');
  });

  it('is a verification failure for a refusal that stored nothing because the package refused it', () => {
    assert.deepEqual(amendmentRefusal(EXECUTION, [reason('PACKAGE_NOT_FINALIZED')]), {
      outcome: 'verification_failed',
      written_paths: [],
      reasons: [reason('PACKAGE_NOT_FINALIZED')],
      execution: EXECUTION,
    });
  });

  it('is an internal failure when any reason says the amendment chain was not read or written', () => {
    for (const code of ['AMENDMENT_NOT_WRITTEN', 'AMENDMENTS_UNREADABLE']) {
      const report = amendmentRefusal(EXECUTION, [reason('OTHER'), reason(code)]);
      assert.equal(report.outcome, 'internal_failure', code);
      assert.deepEqual(report.execution, EXECUTION);
    }
  });
});
