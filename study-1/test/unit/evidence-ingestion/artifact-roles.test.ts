// The record shape each expected artifact class demands (design §8.1, §8.2 I2) and which files
// belong to the evaluated unit rather than to the execution.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ANY_EVENT, expectedRecordShape, isUnitFile } from '../../../src/evidence-ingestion/artifact-roles.ts';

describe('expectedRecordShape', () => {
  it('maps document, stream and journal classes to their record types', () => {
    assert.equal(expectedRecordShape({ artifact_class: 'payment' }), 'payment');
    assert.equal(expectedRecordShape({ artifact_class: 'published_message' }), 'trial_message');
    assert.equal(expectedRecordShape({ artifact_class: 'settlement_samples' }), 'settlement_sample');
    assert.equal(expectedRecordShape({ artifact_class: 'source_observations' }), 'queue_observation');
    assert.equal(expectedRecordShape({ artifact_class: 'dlq_observations' }), 'queue_observation');
    assert.equal(expectedRecordShape({ artifact_class: 'durable_execution_metadata' }), 'durable_execution_metadata');
    for (const journal of ['caller_journal', 'provider_journal', 'controller_journal', 'runner_journal'] as const) {
      assert.equal(expectedRecordShape({ artifact_class: journal }), ANY_EVENT);
    }
  });

  it('demands nothing of an unclassified artifact or a class ingestion does not read', () => {
    assert.equal(expectedRecordShape({}), undefined);
    assert.equal(expectedRecordShape({ artifact_class: 'oracle_result' }), undefined);
  });
});

describe('isUnitFile', () => {
  it('is a subject file of the trial or probe directory', () => {
    assert.equal(isUnitFile({ origin: 'subject', artifact_class: 'caller_journal' }), true);
    assert.equal(isUnitFile({ origin: 'subject', artifact_class: 'payment' }), true);
  });

  it('excludes execution-level classes, unclassified and non-subject artifacts', () => {
    assert.equal(isUnitFile({ origin: 'subject', artifact_class: 'runner_journal' }), false);
    assert.equal(isUnitFile({ origin: 'subject', artifact_class: 'execution_manifest' }), false);
    assert.equal(isUnitFile({ origin: 'subject', artifact_class: 'resource_manifest' }), false);
    assert.equal(isUnitFile({ origin: 'subject' }), false);
    assert.equal(isUnitFile({ origin: 'supplementary' }), false);
    assert.equal(isUnitFile({ origin: 'execution_scope', artifact_class: 'caller_journal' }), false);
  });
});
