// Conformance of ScriptedStreamRecordHandler with the real TreatmentController at the consumer
// boundary (`StreamRecordHandler`): a scripted outcome has the real outcome's shape, a scripted
// failure is the real ControllerFault, and an unscripted call fails loudly.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ControllerFault } from '../../../../src/treatment-controller/controller-fault.ts';
import {
  PROBE,
  callerTimeoutImage,
  controllerHarness,
  probeConfigItem,
  streamInsert,
} from '../../../unit/treatment-controller/support/controller-fixtures.ts';
import { ScriptedStreamRecordHandler } from '../../../unit/treatment-controller/support/scripted-stream-record-handler.ts';

describe('ScriptedStreamRecordHandler conformance', () => {
  it('returns outcomes of the real controller shape and rejects as the real controller does', async () => {
    const real = controllerHarness(PROBE);
    real.store.seed('control', probeConfigItem({ scenario: 'CONTROL' }));
    const record = streamInsert(callerTimeoutImage('probe'));
    const realOutcome = await real.controller.handle(record);
    const fake = new ScriptedStreamRecordHandler();
    fake.returnNext(realOutcome);
    assert.deepEqual(await fake.handle(record), realOutcome);
    assert.deepEqual(Object.keys(realOutcome).sort(), ['detail', 'outcome', 'partition_key']);

    real.store.scriptReadFault('InternalServerError', { table: 'control' });
    const realFailure = await real.controller.handle(record).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(realFailure instanceof ControllerFault);
    fake.throwNext(realFailure);
    await assert.rejects(fake.handle(record), realFailure);
    await assert.rejects(fake.handle(record), { message: 'unscripted handle of 1; expected a script queued first' });
    assert.equal(fake.handled().length, 3);
  });
});
