// AC-RUA-047 golden (BR-RUA-034): "each listed case produces its declared classification", one
// case per rule. Each case states its fault as the smallest edit to a harness base and its
// expectation from the spec text (see each case file's header); the projection compared here is
// what those sentences name: the distinct finding codes, the collapsed duplicate count, the gapped
// instances, the ledger's state, and the three gates ingestion owns (G2, G3, G8). The comparison
// is a partial match, so a case names only what its rule decides.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessEvidenceIntegrity } from '../../../src/evidence-ingestion/evidence-integrity-gate.ts';
import { assessIdentityIntegrity } from '../../../src/evidence-ingestion/identity-integrity-gate.ts';
import { ingestEvidence } from '../../../src/evidence-ingestion/ingest-evidence.ts';
import type { IngestedEvidence } from '../../../src/evidence-ingestion/ingestion-model.ts';
import { assessTraceability } from '../../../src/evidence-ingestion/traceability-gate.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { expectedMismatches, loadGoldenCase } from '../_harness/golden-harness.ts';
import { ingestionInputOf } from './ingestion-input.ts';

const validator = createRecordValidator();

function projection(evidence: IngestedEvidence): JsonValue {
  return {
    finding_codes: [...new Set(evidence.findings.map((finding) => finding.code))].toSorted(),
    collapsed_duplicate_count: evidence.diagnostics.collapsed_duplicate_count,
    gapped_instance_count: [...evidence.events.instances.values()].filter((instance) => instance.gapped).length,
    ledger: {
      status: evidence.ledger.status,
      transaction_count: evidence.ledger.transactions.length,
      duplicate_transaction_ids: [...evidence.ledger.duplicate_transaction_ids],
      pagination_complete: evidence.ledger.pagination_complete,
    },
    gates: {
      traceability: assessTraceability(evidence).value,
      identity_integrity: assessIdentityIntegrity(evidence).value,
      evidence_integrity: assessEvidenceIntegrity(evidence).value,
    },
  };
}

async function mismatchesOf(caseId: string): Promise<readonly string[]> {
  const loaded = await loadGoldenCase(`test/golden/evidence-ingestion/cases/${caseId}.case.ts`);
  const evidence = ingestEvidence(ingestionInputOf(loaded), validator);
  return expectedMismatches(loaded.golden_case.expected, projection(evidence));
}

describe('AC-RUA-047 duplicates and conflicts are classified', () => {
  it('equivalent-duplicate-collapsed', async () => {
    assert.deepEqual(await mismatchesOf('equivalent-duplicate-collapsed'), []);
  });

  it('conflicting-event-content', async () => {
    assert.deepEqual(await mismatchesOf('conflicting-event-content'), []);
  });

  it('conflicting-source-sequence', async () => {
    assert.deepEqual(await mismatchesOf('conflicting-source-sequence'), []);
  });

  it('sequence-gap', async () => {
    assert.deepEqual(await mismatchesOf('sequence-gap'), []);
  });

  it('missing-causal-predecessor', async () => {
    assert.deepEqual(await mismatchesOf('missing-causal-predecessor'), []);
  });

  it('duplicate-ledger-tx-id', async () => {
    assert.deepEqual(await mismatchesOf('duplicate-ledger-tx-id'), []);
  });

  it('incomplete-pagination', async () => {
    assert.deepEqual(await mismatchesOf('incomplete-pagination'), []);
  });

  it('core-file-digest-mismatch', async () => {
    assert.deepEqual(await mismatchesOf('core-file-digest-mismatch'), []);
  });

  it('ledger-larger-than-expected-not-truncated', async () => {
    assert.deepEqual(await mismatchesOf('ledger-larger-than-expected-not-truncated'), []);
  });
});
