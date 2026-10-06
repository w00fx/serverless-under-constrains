// AC-RUA-046 (group C, rows 79, 80, 84 and 86): the cross-field rules of finalized packages and
// their amendments. Each case breaks one rule of a valid example and expects the rejection at
// the member that rule governs.

import { describe, it } from 'node:test';

import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { assertAccepted, assertForbidden, assertRejected } from '../group-b/support/group-b-validation.ts';
import { withValueAt } from '../group-b/support/json-paths.ts';
import { PROBE_ID, RUN_ID, TRIAL_ID, VALIDATION_ID, digest, toJson } from '../group-b/support/record-builders.ts';
import {
  chainedAmendmentIndex,
  eligiblePackage,
  firstAmendmentIndex,
  ineligiblePackage,
  probePackageIndex,
  runPackageIndex,
  unknownHeadPackage,
  unverifiedBilling,
  withinLimitBilling,
} from './examples/package-examples.ts';
import { arrayAt, edited } from './support/json-edits.ts';

function codedReasons(code: string): JsonValue {
  return [{ code, subject: 'package', detail: `package reported ${code}` }];
}

describe('AC-RUA-046 package_index rules (BR-RUA-044)', () => {
  const run = toJson(runPackageIndex());
  const probe = toJson(probePackageIndex());
  const entries = arrayAt(run, 'entries');

  it('the execution kind names the one identity the package carries', () => {
    assertRejected(edited(run, { run_id: undefined }), 'RUN without run', ' required');
    assertForbidden(edited(run, { transport_probe_id: PROBE_ID }), 'RUN with probe', '/transport_probe_id');
    assertForbidden(edited(probe, { run_id: RUN_ID }), 'probe with run', '/run_id');
    assertRejected(
      edited(run, { execution_kind: 'TRANSPORT_PROBE' }),
      'RUN identity under probe kind',
      '/run_id false schema',
    );
    assertAccepted(
      edited(run, { execution_kind: 'VARIANT_VALIDATION', run_id: undefined, variant_validation_id: VALIDATION_ID }),
      'validation package',
    );
    assertRejected(
      edited(run, { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: VALIDATION_ID }),
      'two identities',
      '/run_id false schema',
    );
    assertForbidden(edited(run, { trial_id: TRIAL_ID }), 'trial identity', '/trial_id');
  });

  it('lists every file but itself, sorted by unique path, late evidence and summaries included', () => {
    assertRejected(edited(run, { entries: [] }), 'empty', '/entries minItems');
    assertRejected(edited(run, { entries: entries.toReversed() }), 'unsorted', '/entries x-rua-evidence-ref-order');
    assertRejected(
      edited(run, { entries: [...entries, entries.at(-1) ?? null] }),
      'duplicate',
      '/entries x-rua-evidence-ref-order',
    );
    const last = entries.length - 1;
    assertRejected(
      withValueAt(run, ['entries', 0, 'artifact_path'], 'package-index.json'),
      'itself',
      '/entries/0/artifact_path not',
    );
    assertAccepted(
      withValueAt(run, ['entries', last, 'artifact_path'], 'trials/z/package-index.json'),
      'a nested file of that name',
    );
    assertRejected(
      withValueAt(run, ['entries', 0, 'artifact_class'], 'notes'),
      'unknown class',
      '/entries/0/artifact_class enum',
    );
    assertRejected(
      withValueAt(run, ['entries', 0, 'derivation'], 'copied'),
      'unknown derivation',
      '/entries/0/derivation enum',
    );
  });
});

describe('AC-RUA-046 package_verification rules (BR-RUA-044, AC-RUA-022, D-12)', () => {
  const eligible = toJson(eligiblePackage());
  const ineligible = toJson(ineligiblePackage());

  it('eligible exactly when no package-ineligibility reason is stated', () => {
    assertRejected(
      edited(eligible, { package_ineligibility_reasons: codedReasons('CYCLE') }),
      'eligible with reason',
      '/package_ineligibility_reasons maxItems',
    );
    assertRejected(
      edited(ineligible, { package_ineligibility_reasons: [] }),
      'ineligible without reason',
      '/package_ineligibility_reasons minItems',
    );
    assertRejected(
      edited(ineligible, { package_ineligibility_reasons: codedReasons('VERDICT_FAILED') }),
      'scientific reason',
      '/package_ineligibility_reasons/0/code enum',
    );
  });

  it('no selected head means no selected chain; an eligible head selects at least one amendment', () => {
    assertRejected(
      edited(eligible, { selected_chain: arrayAt(ineligible, 'selected_chain') }),
      'chain without head',
      '/selected_chain maxItems',
    );
    assertRejected(
      edited(eligible, {
        selected_amendment_head_sha256: digest('amendment-index-1'),
        known_descendants: arrayAt(ineligible, 'selected_chain'),
      }),
      'eligible head without chain',
      '/selected_chain minItems',
    );
    assertAccepted(
      edited(eligible, {
        selected_amendment_head_sha256: digest('amendment-index-1'),
        selected_chain: arrayAt(ineligible, 'selected_chain'),
      }),
      'eligible head with its chain',
    );
    // Design §8.16 step 6: a head that resolves to nothing is recorded as requested, chain empty.
    assertAccepted(toJson(unknownHeadPackage()), 'UNKNOWN_HEAD with an empty chain');
    assertAccepted(edited(ineligible, { selected_chain: [] }), 'ineligible head without chain');
    assertRejected(
      edited(toJson(unknownHeadPackage()), {
        selected_amendment_head_sha256: null,
        selected_chain: arrayAt(ineligible, 'selected_chain'),
      }),
      'null head with chain',
      '/selected_chain maxItems',
    );
    assertAccepted(
      edited(eligible, { known_descendants: arrayAt(ineligible, 'known_descendants') }),
      'unselected descendants of an original',
    );
  });

  it('links amendments by sequence, id, kind and index digest', () => {
    assertRejected(
      withValueAt(ineligible, ['selected_chain', 0, 'sequence'], 0),
      'sequence 0',
      '/selected_chain/0/sequence minimum',
    );
    assertRejected(
      withValueAt(ineligible, ['selected_chain', 0, 'amendment_kind'], 'SCIENTIFIC'),
      'unknown kind',
      '/selected_chain/0/amendment_kind enum',
    );
    assertRejected(
      withValueAt(ineligible, ['selected_chain', 0, 'amendment_index_sha256'], undefined),
      'no digest',
      '/selected_chain/0 required',
    );
  });

  it('names exactly one execution and is never frozen with a manifest digest', () => {
    assertRejected(edited(eligible, { run_id: undefined }), 'no execution', ' oneOf');
    assertRejected(edited(eligible, { transport_probe_id: PROBE_ID }), 'two executions', ' oneOf');
    assertRejected(
      edited(eligible, { execution_manifest_sha256: digest('m') }),
      'manifest digest',
      ' unevaluatedProperties',
    );
  });
});

describe('AC-RUA-046 amendment_index rules (BR-RUA-043, D-12)', () => {
  const first = toJson(firstAmendmentIndex());
  const chained = toJson(chainedAmendmentIndex());

  it('records the parent digest; the verifier, not the schema, judges the chain', () => {
    assertAccepted(
      edited(chained, { parent_amendment_index_sha256: null }),
      'a broken parent is still a well-formed record',
    );
    assertAccepted(
      edited(first, { parent_amendment_index_sha256: digest('x') }),
      'a parent at sequence 1 is still a well-formed record',
    );
    assertRejected(edited(first, { parent_amendment_index_sha256: undefined }), 'parent omitted', ' required');
    assertRejected(edited(first, { sequence: 0 }), 'sequence 0', '/sequence minimum');
  });

  it('lists every payload file but itself, sorted by unique path', () => {
    const entries = arrayAt(first, 'entries');
    assertRejected(edited(first, { entries: [] }), 'empty', '/entries minItems');
    assertRejected(edited(first, { entries: entries.toReversed() }), 'unsorted', '/entries x-rua-evidence-ref-order');
    assertRejected(
      withValueAt(first, ['entries', 1, 'artifact_path'], 'payload/z/amendment-index.json'),
      'itself',
      '/entries/1/artifact_path not',
    );
    assertRejected(
      withValueAt(first, ['entries', 0, 'artifact_path'], 'amendment-index.json'),
      'root index',
      '/entries/0/artifact_path not',
    );
  });

  it('carries a known amendment kind and no trial identity', () => {
    assertRejected(edited(first, { amendment_kind: 'SCIENTIFIC' }), 'unknown kind', '/amendment_kind enum');
    assertForbidden(edited(first, { trial_id: TRIAL_ID }), 'trial identity', '/trial_id');
  });
});

describe('AC-RUA-046 billing_import rules (BR-RUA-047)', () => {
  const within = toJson(withinLimitBilling());
  const unverified = toJson(unverifiedBilling());
  const usdLines = arrayAt(within, 'lines_used');

  it('a conclusive check states the exact USD total from USD lines of a final period', () => {
    assertRejected(edited(within, { attributed_total_usd: undefined }), 'no total', ' required');
    assertRejected(
      edited(within, { reasons: codedReasons('MIXED_CURRENCY') }),
      'conclusive with reasons',
      '/reasons maxItems',
    );
    assertRejected(
      withValueAt(within, ['lines_used', 0, 'currency'], 'EUR'),
      'EUR line',
      '/lines_used/0/currency const',
    );
    assertRejected(
      withValueAt(within, ['billing_export', 'period_final'], false),
      'open period',
      '/billing_export/period_final const',
    );
    assertAccepted(edited(within, { billed_cost_check: 'breached', attributed_total_usd: '6.25' }), 'breached ceiling');
  });

  it('unverified states its reasons and no total', () => {
    assertForbidden(
      edited(unverified, { attributed_total_usd: '0.0142' }),
      'unverified with total',
      '/attributed_total_usd',
    );
    assertRejected(edited(unverified, { reasons: [] }), 'unverified without reasons', '/reasons minItems');
    assertRejected(
      edited(unverified, { reasons: codedReasons('EXCHANGE_RATE') }),
      'unknown code',
      '/reasons/0/code enum',
    );
    assertAccepted(
      edited(unverified, { lines_used: usdLines, reasons: codedReasons('SHARED_OR_UNOWNED_CHARGE') }),
      'unverified USD lines',
    );
  });

  it('keeps currencies and money exact, never converted', () => {
    assertRejected(
      withValueAt(unverified, ['lines_used', 1, 'currency'], 'eur'),
      'lowercase currency',
      '/lines_used/1/currency pattern',
    );
    for (const cost of ['-1', '1e3', '01.5', '.5', '1.']) {
      assertRejected(
        withValueAt(within, ['lines_used', 0, 'cost'], cost),
        `cost ${cost}`,
        '/lines_used/0/cost pattern',
      );
    }
    assertRejected(edited(within, { ceiling_usd: 5 }), 'numeric ceiling', '/ceiling_usd type');
    assertRejected(edited(within, { exchange_rate: '1.08' }), 'conversion', ' unevaluatedProperties');
    assertRejected(
      withValueAt(within, ['exclusions', 0, 'exclusion'], 'ROUNDING'),
      'unknown exclusion',
      '/exclusions/0/exclusion enum',
    );
    assertForbidden(edited(within, { trial_id: TRIAL_ID }), 'trial identity', '/trial_id');
  });
});
