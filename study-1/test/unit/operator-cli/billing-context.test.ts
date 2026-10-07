// The attribution inputs of `billing import` (design §8.17; BR-RUA-047; decision 73): the window
// is the first mutation floored and the cleanup terminal instant ceiled to the hour; the identities
// are the frozen manifest's physical ids and stack id; the Owner-signed allowlist is empty, so every
// import is `unverified`; and the demotion keeps a conclusive record only when nothing demotes it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { billingContextOf, demotedBillingImport } from '../../../src/operator-cli/billing-context.ts';
import { OWNER_SIGNED_BILLING_FACTS } from '../../../src/operator-cli/billing-facts.ts';
import type { BillingFactTable } from '../../../src/operator-cli/billing-facts.ts';
import type { PackageClosure } from '../../../src/operator-cli/package-closure.ts';
import type { Sha256Hex, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { ResourceManifest } from '../../../src/record-contract/records/group-a/resource_manifest.ts';
import type { BillingImport } from '../../../src/record-contract/records/group-c/billing_import.ts';
import { CANONICAL_EXAMPLES } from '../../contract/record-contract/group-c/examples/group-c-examples.ts';
import { frozenCoreFiles } from '../../support/offline-cloud/offline-execution.ts';
import { goldenAdmitted } from './support/golden-admitted.ts';

const RUN = goldenAdmitted('run');
const MANIFEST = JSON.parse(
  new TextDecoder().decode(frozenCoreFiles('run').core_files.get(EXECUTION_PATHS.resourceManifest)),
) as ResourceManifest;
const PROVIDER_ARN = 'arn:aws:lambda:us-east-1:012345678901:function:suc1-b42ee7a8-refund-provider:1';
const SIGNED: BillingFactTable = {
  charge_allowlist: [{ product_code: 'AWSLambda', operations: ['Invoke'] }],
  provenance: 'test table',
};

function closureOf(overrides: Partial<PackageClosure> = {}): PackageClosure {
  return {
    files: [],
    index_sha256: 'c'.repeat(64) as Sha256Hex,
    resource_manifest: MANIFEST,
    first_mutation_at: '2026-10-05T12:03:10.000Z' as UtcMillis,
    cleanup_terminal_at: '2026-10-05T13:40:00.000Z' as UtcMillis,
    closure: { cleanup_status: 'succeeded', leak_audit_status: 'clean', recovered: false },
    ...overrides,
  };
}

describe('billingContextOf', () => {
  it('assembles the identity, account, identities and hour-aligned window of the package', () => {
    const context = billingContextOf(RUN, closureOf(), SIGNED);
    assert.equal(context.ok, true);
    assert.deepEqual(context.value, {
      input: {
        identity: RUN.identity,
        account_id: '012345678901',
        resource_identities: [PROVIDER_ARN, MANIFEST.stack_id],
        charge_allowlist: SIGNED.charge_allowlist,
        first_mutation_at: '2026-10-05T12:03:10.000Z',
        cleanup_terminal_at: '2026-10-05T13:40:00.000Z',
      },
      window: { start: '2026-10-05T12:00:00.000Z', end: '2026-10-05T14:00:00.000Z' },
      reasons: [],
    });
  });

  it('demotes under the empty Owner-signed allowlist and names its provenance', () => {
    assert.deepEqual(OWNER_SIGNED_BILLING_FACTS.charge_allowlist, []);
    const context = billingContextOf(RUN, closureOf(), OWNER_SIGNED_BILLING_FACTS);
    assert.equal(context.ok, true);
    assert.deepEqual(
      context.value.reasons.map((reason) => [reason.code, reason.detail.split(';')[0]]),
      [
        [
          'INCOMPLETE_ATTRIBUTION',
          'the Owner-signed charge allowlist is empty (U-10 unsourced (decision 73): the cloud phase sources the CUR 2.0 product/operation pairs)',
        ],
      ],
    );
  });

  it('demotes a package whose manifest proves no resource identity, and deduplicates identities', () => {
    const { resource_manifest: _manifest, ...unprovisioned } = closureOf();
    const none = billingContextOf(RUN, unprovisioned, SIGNED);
    assert.equal(none.ok, true);
    assert.deepEqual(none.value.input.resource_identities, []);
    assert.deepEqual(
      none.value.reasons.map((reason) => reason.detail.split(';')[0]),
      ['the frozen resource manifest proves no resource identity'],
    );
    const { stack_id: _stack, ...stackless } = MANIFEST;
    const repeated = {
      ...stackless,
      resources: [...MANIFEST.resources, ...MANIFEST.resources, { ...MANIFEST.resources[0], physical_id: undefined }],
    } as unknown as ResourceManifest;
    const deduplicated = billingContextOf(RUN, closureOf({ resource_manifest: repeated }), SIGNED);
    assert.equal(deduplicated.ok, true);
    assert.deepEqual(deduplicated.value.input.resource_identities, [PROVIDER_ARN]);
  });

  it('refuses a package with no first mutation or no cleanup terminal instant', () => {
    const { first_mutation_at: _first, ...noFirst } = closureOf();
    assert.deepEqual(billingContextOf(RUN, noFirst, SIGNED), {
      ok: false,
      error: {
        code: 'BILLING_WINDOW_UNKNOWN',
        subject: 'BR-RUA-047',
        detail: `${RUN.package_directory} records first mutation undefined and cleanup terminal 2026-10-05T13:40:00.000Z; expected both, to bound the attribution window`,
      },
    });
    const { cleanup_terminal_at: _terminal, ...noTerminal } = closureOf();
    const refused = billingContextOf(RUN, noTerminal, SIGNED);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'BILLING_WINDOW_UNKNOWN');
  });
});

describe('demotedBillingImport', () => {
  const conclusive: BillingImport = CANONICAL_EXAMPLES.billing_import();

  it('returns a conclusive record that attributes lines unchanged when nothing demotes it', () => {
    assert.equal(conclusive.billed_cost_check, 'within_limit');
    assert.equal(demotedBillingImport(conclusive, []), conclusive);
  });

  it('demotes to unverified with the catalogue-ordered reasons and drops the total', () => {
    const period = { code: 'INCOMPLETE_PERIOD' as const, subject: 'BR-RUA-047', detail: 'period' };
    const attribution = { code: 'INCOMPLETE_ATTRIBUTION' as const, subject: 'BR-RUA-047', detail: 'scope' };
    const demoted = demotedBillingImport(conclusive, [period, attribution]);
    assert.equal(demoted.billed_cost_check, 'unverified');
    assert.equal('attributed_total_usd' in demoted, false);
    assert.deepEqual(demoted.reasons, [attribution, period]);
    assert.deepEqual(demoted.lines_used, conclusive.lines_used);
  });

  it('demotes a record that attributes no line even without other reasons', () => {
    const empty = { ...conclusive, lines_used: [] } as BillingImport;
    const demoted = demotedBillingImport(empty, []);
    assert.equal(demoted.billed_cost_check, 'unverified');
    assert.deepEqual(
      demoted.reasons.map((reason) => [reason.code, reason.detail.split(';')[0]]),
      [['INCOMPLETE_ATTRIBUTION', 'the export attributes no line to the execution']],
    );
  });
});
