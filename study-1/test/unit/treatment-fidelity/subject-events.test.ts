// Typed access to the subject partition's events (design §8.10): the probe's partition is
// `execution`; a trial's is its trial id; only own string members are read (A-05).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  causedBy,
  eventsOfType,
  eventString,
  isCallerEvent,
  partitionEvents,
  subjectPartition,
} from '../../../src/treatment-fidelity/subject-events.ts';
import { PROBE_IDS, probeEvidence, trialEvidence } from './support/treatment-evidence.ts';
import { present } from './support/view-edits.ts';

describe('subject events', () => {
  it("uses 'execution' as the probe partition and the trial id for a trial", () => {
    assert.equal(subjectPartition(probeEvidence()), 'execution');
    const trial = trialEvidence('run-conventional-treatment');
    assert.equal(subjectPartition(trial), trial.scope.trial?.trial_id);
  });

  it('keeps only the events of the subject partition', () => {
    const trial = trialEvidence('run-conventional-treatment');
    const events = partitionEvents(trial);
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.partition === trial.scope.trial?.trial_id));
    assert.ok(events.length < trial.events.subject.length, 'execution-level runner events are excluded');
  });

  it('selects events by record type', () => {
    const events = partitionEvents(probeEvidence());
    const timeouts = eventsOfType(events, 'caller_timeout_recorded');
    assert.deepEqual(
      timeouts.map((event) => event.record.event_id),
      [PROBE_IDS.timeout_event],
    );
    assert.deepEqual(eventsOfType(events, 'treatment_safety_released'), []);
  });

  it('reads own string members only, never inherited names or other types', () => {
    const outcome = present(
      eventsOfType(partitionEvents(probeEvidence()), 'attempt_outcome_recorded')[0],
      'attempt_outcome_recorded',
    );
    assert.equal(eventString(outcome, 'attempt_id'), PROBE_IDS.attempt);
    assert.equal(eventString(outcome, 'provider_transaction_id'), undefined);
    assert.equal(eventString(outcome, 'constructor'), undefined);
    assert.equal(eventString(outcome, 'source_sequence'), undefined);
  });

  it('recognizes caller events by their source', () => {
    const events = partitionEvents(probeEvidence());
    const dispatch = present(eventsOfType(events, 'dispatch_started')[0], 'dispatch_started');
    const signal = present(eventsOfType(events, 'timeout_signal_recorded')[0], 'timeout_signal_recorded');
    assert.equal(isCallerEvent(dispatch), true);
    assert.equal(isCallerEvent(signal), false);
  });

  it('tells immediate causation only', () => {
    const events = partitionEvents(probeEvidence());
    const release = present(eventsOfType(events, 'treatment_response_released')[0], 'treatment_response_released');
    const observation = present(eventsOfType(events, 'treatment_timeout_observed')[0], 'treatment_timeout_observed');
    const signal = present(eventsOfType(events, 'timeout_signal_recorded')[0], 'timeout_signal_recorded');
    assert.equal(causedBy(release, observation), true);
    assert.equal(causedBy(release, signal), false);
    const started = present(eventsOfType(events, 'caller_invocation_started')[0], 'caller_invocation_started');
    assert.equal(causedBy(started, release), false, 'an event without causation names no predecessor');
  });
});
