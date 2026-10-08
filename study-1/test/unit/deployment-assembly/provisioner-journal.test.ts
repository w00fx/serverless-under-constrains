// The provisioning journal (design §7, §9.8 D1-D4; BR-RUA-033, BR-RUA-040): one
// `provisioning_event_recorded` line per step in `provisioning/provisioning-journal.jsonl`, written
// by the runner's own source instance in the execution partition, each caused by the step before,
// every line valid against its schema, and an event that cannot be written returned as a reason.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProvisioningJournal } from '../../../src/deployment-assembly/provisioning-journal.ts';
import type { JsonValue, Sha256Hex } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { RUN_IDENTITY, RUN_STACK, SteppingWallClock } from '../../support/deployment-assembly/deployment-fixtures.ts';
import { stackIdOf } from '../../support/deployment-assembly/deployed-account.ts';
import { MemoryAppendOnlyFile } from '../../support/event-journal/memory-append-only-file.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';

const PACKAGE = 'runs/3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f';
const PATH = `${PACKAGE}/provisioning/provisioning-journal.jsonl`;
const INVENTORY = 'a'.repeat(64) as Sha256Hex;
const FAILURE = { code: 'DEPLOY_COMMAND_FAILED', subject: 'BR-RUA-040', detail: 'cdk deploy exited with status 1' };

function journal(file: MemoryAppendOnlyFile): ProvisioningJournal {
  return new ProvisioningJournal({
    file,
    package_directory: PACKAGE,
    identity: RUN_IDENTITY,
    execution_manifest_sha256: 'e'.repeat(64) as Sha256Hex,
    clock: new SteppingWallClock(),
    ids: new SequentialUuidSource('0000000c'),
  });
}

function lines(file: MemoryAppendOnlyFile): readonly Readonly<Record<string, JsonValue>>[] {
  return (file.text(PATH) ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Readonly<Record<string, JsonValue>>);
}

describe('ProvisioningJournal', () => {
  it('appends every step with its own fields, each caused by the one before', async () => {
    const file = new MemoryAppendOnlyFile();
    const steps = journal(file);
    assert.deepEqual(
      [
        await steps.copyVerified(INVENTORY),
        await steps.deployStarted(RUN_STACK),
        await steps.deploySucceeded(),
        await steps.deployFailed([FAILURE]),
        await steps.assemblyReverified(INVENTORY),
        await steps.stackIdRecorded(stackIdOf(RUN_STACK)),
      ],
      [undefined, undefined, undefined, undefined, undefined, undefined],
    );
    const written = lines(file);
    assert.deepEqual(
      written.map((line) => [line['provisioning_event'], line['source_sequence']]),
      [
        ['DEPLOY_COPY_VERIFIED', 1],
        ['DEPLOY_STARTED', 2],
        ['DEPLOY_SUCCEEDED', 3],
        ['DEPLOY_FAILED', 4],
        ['PACKAGE_ASSEMBLY_REVERIFIED', 5],
        ['STACK_ID_RECORDED', 6],
      ],
    );
    assert.equal(written[0]?.['inventory_sha256'], INVENTORY);
    assert.equal(written[1]?.['stack_name'], RUN_STACK);
    assert.deepEqual(written[3]?.['reasons'], [FAILURE]);
    assert.equal(written[4]?.['inventory_sha256'], INVENTORY);
    assert.equal(written[5]?.['stack_id'], stackIdOf(RUN_STACK));
    for (let index = 1; index < written.length; index += 1) {
      assert.deepEqual(written[index]?.['causation_event_ids'], [written[index - 1]?.['event_id']]);
    }
    const validator = createRecordValidator();
    for (const line of written) {
      assert.ok(validator.validateAs('provisioning_event_recorded', line).valid);
      assert.equal(line['source'], 'runner');
      assert.equal(line['source_instance_id'], '0000000c-0000-4000-8000-000000000001');
    }
  });

  it('returns a reason naming the event when it is not appended', async () => {
    const file = new MemoryAppendOnlyFile();
    file.failWriteAt(PATH, 1, 'written_unacknowledged');
    const steps = journal(file);
    const problem = await steps.copyVerified(INVENTORY);
    assert.ok(problem !== undefined);
    assert.equal(problem.code, 'PROVISIONING_EVENT_NOT_WRITTEN');
    assert.equal(problem.subject, 'BR-RUA-040');
    assert.match(
      problem.detail,
      /^DEPLOY_COPY_VERIFIED was not appended \(.+\); expected it in provisioning\/provisioning-journal\.jsonl$/,
    );
    const later = await steps.deployStarted(RUN_STACK);
    assert.match(later?.detail ?? '', /^DEPLOY_STARTED was not appended \(INSTANCE_ALREADY_STOPPED: /);
  });

  it('keeps the chain on the last written event when one in between fails', async () => {
    const file = new MemoryAppendOnlyFile();
    file.failWriteAt(PATH, 2, 'nothing_written');
    const steps = journal(file);
    await steps.copyVerified(INVENTORY);
    await steps.deployStarted(RUN_STACK);
    const written = lines(file);
    assert.deepEqual(written[1]?.['causation_event_ids'], [written[0]?.['event_id']]);
  });
});
