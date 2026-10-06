// Subject artifact completeness and the findings that touch cited evidence (BR-RUA-034, design
// §8.10 "affected_by").

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IngestionFinding } from '../../../src/evidence-ingestion/ingestion-model.ts';
import type { EvidenceRef } from '../../../src/record-contract/evidence-refs.ts';
import type { Sha256Hex, Uuid4 } from '../../../src/record-contract/primitives.ts';
import {
  affectingFindings,
  incompleteArtifactReason,
  subjectArtifactState,
} from '../../../src/treatment-fidelity/subject-artifacts.ts';
import { PROBE_IDS, probeEvidence, trialEvidence } from './support/treatment-evidence.ts';
import { PROBE_EDITS } from './support/treatment-scenarios.ts';

const DIGEST = 'a'.repeat(64) as Sha256Hex;
const CALLER = 'probe/journals/caller-journal.jsonl';
const PROVIDER = 'probe/journals/provider-journal.jsonl';

function finding(code: IngestionFinding['code'], at: { artifact_path?: string; event_id?: Uuid4 }): IngestionFinding {
  return { code, subject: 'BR-RUA-034', detail: `${code} for the test`, occurrences: 1, ...at };
}

function ref(path: string, eventId?: Uuid4): EvidenceRef {
  return { artifact_path: path, artifact_sha256: DIGEST, ...(eventId === undefined ? {} : { event_id: eventId }) };
}

describe('subjectArtifactState', () => {
  it('reports a present, parsed, finding-free artifact as complete with its reference', () => {
    const state = subjectArtifactState(probeEvidence(), 'caller_journal');
    assert.equal(state.path, CALLER);
    assert.equal(state.complete, true);
    assert.equal(state.ref?.artifact_path, CALLER);
  });

  it('reports an absent artifact at its expected path, incomplete and without a reference', () => {
    const state = subjectArtifactState(probeEvidence(PROBE_EDITS.no_caller_journal), 'caller_journal');
    assert.deepEqual(state, { artifact_class: 'caller_journal', path: CALLER, complete: false });
  });

  it('marks a journal with a non-benign finding incomplete', () => {
    assert.equal(
      subjectArtifactState(probeEvidence(PROBE_EDITS.no_observation_gapped), 'provider_journal').complete,
      false,
    );
    assert.equal(
      subjectArtifactState(probeEvidence(PROBE_EDITS.invalid_outcome_record), 'caller_journal').complete,
      false,
    );
  });

  it('keeps a journal complete when a missing predecessor belongs to another journal', () => {
    const evidence = probeEvidence(PROBE_EDITS.no_caller_timeout);
    assert.ok(evidence.findings.some((item) => item.code === 'CAUSAL_PREDECESSOR_MISSING'));
    assert.equal(subjectArtifactState(evidence, 'controller_journal').complete, true);
  });

  it('keeps a ledger larger than expected complete (a benign finding)', () => {
    const evidence = trialEvidence('run-conventional-treatment');
    assert.ok(evidence.findings.some((item) => item.code === 'LEDGER_LARGER_THAN_EXPECTED'));
    assert.equal(subjectArtifactState(evidence, 'ledger_snapshot').complete, true);
  });

  it('names an unexpected class at its layout path for the probe and for a trial', () => {
    const probe = { ...probeEvidence(), expected: [], artifacts: new Map() };
    assert.equal(subjectArtifactState(probe, 'ledger_snapshot').path, 'probe/ledger/ledger-snapshot.json');
    const trial = trialEvidence('run-conventional-treatment');
    const unexpected = { ...trial, expected: [], artifacts: new Map() };
    assert.equal(
      subjectArtifactState(unexpected, 'controller_journal').path,
      `trials/${String(trial.scope.trial?.trial_id)}/journals/controller-journal.jsonl`,
    );
    assert.equal(subjectArtifactState(unexpected, 'runner_journal').path, 'runner/runner-journal.jsonl');
  });
});

describe('incompleteArtifactReason', () => {
  it('is ARTIFACT_MISSING at the path for an absent artifact', () => {
    const state = subjectArtifactState(probeEvidence(PROBE_EDITS.no_caller_journal), 'caller_journal');
    const reason = incompleteArtifactReason(state, 'BR-RUA-011');
    assert.deepEqual([reason.code, reason.subject, reason.artifact_path], ['ARTIFACT_MISSING', 'BR-RUA-011', CALLER]);
  });

  it('is ARTIFACT_INCOMPLETE for a present but gapped artifact', () => {
    const state = subjectArtifactState(probeEvidence(PROBE_EDITS.no_observation_gapped), 'provider_journal');
    const reason = incompleteArtifactReason(state, 'BR-RUA-012');
    assert.deepEqual([reason.code, reason.artifact_path], ['ARTIFACT_INCOMPLETE', PROVIDER]);
  });
});

describe('affectingFindings', () => {
  it('matches an event finding to a reference to that event only', () => {
    const onEvent = finding('CAUSAL_PREDECESSOR_MISSING', {
      artifact_path: PROVIDER,
      event_id: PROBE_IDS.release_event,
    });
    assert.deepEqual(affectingFindings([onEvent], [ref(PROVIDER, PROBE_IDS.release_event)]), [onEvent]);
    assert.deepEqual(affectingFindings([onEvent], [ref(PROVIDER, PROBE_IDS.observation_event)]), []);
    assert.deepEqual(affectingFindings([onEvent], [ref(PROVIDER)]), []);
  });

  it('matches an artifact finding to every reference into that artifact', () => {
    const onArtifact = finding('SOURCE_SEQUENCE_GAP', { artifact_path: PROVIDER });
    assert.deepEqual(affectingFindings([onArtifact], [ref(PROVIDER, PROBE_IDS.release_event)]), [onArtifact]);
    assert.deepEqual(affectingFindings([onArtifact], [ref(CALLER)]), []);
  });

  it('ignores a finding located nowhere and the benign codes', () => {
    const nowhere = finding('SOURCE_SEQUENCE_GAP', {});
    const collapsed = finding('EQUIVALENT_DUPLICATE_COLLAPSED', { artifact_path: PROVIDER });
    const larger = finding('LEDGER_LARGER_THAN_EXPECTED', { artifact_path: PROVIDER });
    assert.deepEqual(affectingFindings([nowhere, collapsed, larger], [ref(PROVIDER)]), []);
  });
});
