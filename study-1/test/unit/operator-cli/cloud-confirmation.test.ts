// The cloud-mutation confirmation (design §11; D-14): accepted only when the flag's value equals
// the id the command acts on; any other value, the empty one included, is a usage error naming both.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ParsedArgs } from '../../../src/operator-cli/cli-types.ts';
import {
  CONFIRM_FLAG,
  COORDINATION_CONFIRMATION,
  confirmCloudMutation,
} from '../../../src/operator-cli/cloud-confirmation.ts';

const ID = 'b42ee7a8-4b45-43d7-8ca3-cb72ceae84c4';

function argsWith(flags: ReadonlyMap<string, string>): ParsedArgs {
  return { command: 'run execute', positionals: new Map(), flags, evidence_root: 'evidence' };
}

describe('confirmCloudMutation', () => {
  it('names the flag and the coordination confirmation the design table gives', () => {
    assert.equal(CONFIRM_FLAG, 'confirm-cloud-mutation');
    assert.equal(COORDINATION_CONFIRMATION, 'coordination');
  });

  it('accepts exactly the expected id', () => {
    assert.deepEqual(confirmCloudMutation(argsWith(new Map([[CONFIRM_FLAG, ID]])), ID), { ok: true, value: undefined });
  });

  it('refuses another id, a different case and an absent flag, naming both values', () => {
    assert.deepEqual(confirmCloudMutation(argsWith(new Map([[CONFIRM_FLAG, ID.toUpperCase()]])), ID), {
      ok: false,
      error: {
        code: 'USAGE_ERROR',
        subject: 'operator-cli',
        detail: `--confirm-cloud-mutation "${ID.toUpperCase()}" does not confirm "${ID}"; expected --confirm-cloud-mutation ${ID}`,
      },
    });
    const absent = confirmCloudMutation(argsWith(new Map()), COORDINATION_CONFIRMATION);
    assert.equal(absent.ok, false);
    assert.equal(
      absent.error.detail,
      '--confirm-cloud-mutation "" does not confirm "coordination"; expected --confirm-cloud-mutation coordination',
    );
  });
});
