// `rua billing import <package> --export <dir>` over a package the real runner finalized (design
// §8.17, §11; BR-RUA-043, BR-RUA-047; decision 73): one BILLING amendment carries the import record
// and the delivery's exact bytes; under the Owner-signed facts in force (an empty allowlist) every
// import is `unverified`, and only a signed allowlist with a delivery that covers the window and the
// account lets a line be attributed. A refused delivery, a package without a window and an export
// that does not parse write nothing (5); an unreadable directory is a usage error (2); an amendment
// that could not be stored is 10.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PackageFileSystem } from '../../../src/evidence-package/package-file-system.ts';
import {
  AMENDMENT_PATHS,
  EXECUTION_PATHS,
  PACKAGE_LAYOUT,
  executionIdOf,
} from '../../../src/evidence-package/package-layout.ts';
import type { DeliveryEntry } from '../../../src/operator-cli/billing-delivery.ts';
import { OWNER_SIGNED_BILLING_FACTS } from '../../../src/operator-cli/billing-facts.ts';
import type { BillingFactTable } from '../../../src/operator-cli/billing-facts.ts';
import { BillingImportCommand } from '../../../src/operator-cli/billing-import-command.ts';
import { readPackageClosure } from '../../../src/operator-cli/package-closure.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import type { ResourceManifest } from '../../../src/record-contract/records/group-a/resource_manifest.ts';
import { CUR_LINE_COLUMNS, CUR_PERIOD_COLUMNS } from '../../../src/billing-amendment/cur-export.ts';
import { OfflinePackageStorage } from '../../support/offline-cloud/offline-package-storage.ts';
import { csvBytes, curCsv, curRecord } from '../../unit/billing-amendment/support/cur-export-builder.ts';
import { runCli } from '../../unit/operator-cli/support/cli-harness.ts';
import type { CliRun } from '../../unit/operator-cli/support/cli-harness.ts';
import { MemoryDeliveryDirectory } from '../../unit/operator-cli/support/memory-delivery-directory.ts';
import { STORED_EVIDENCE_ROOT, packageOperand } from '../../unit/operator-cli/support/stored-packages.ts';
import { RefusingPackageStorage } from '../execution-lifecycle/fakes/refusing-package-storage.ts';
import { lifecycleValidator } from '../execution-lifecycle/support/execution-fixtures.ts';
import { RunnerWorld } from '../execution-lifecycle/support/runner-world.ts';
import { copyEvidence } from './support/offline-executions.ts';

const DELIVERY_DIR = '/operator/cur/2026-10';
const MANIFEST_PATH = 'metadata/suc-cur-Manifest.json';
const DATA_PATH = 'data/suc-cur-00001.csv';
const SIGNED: BillingFactTable = {
  charge_allowlist: [{ product_code: 'AWSLambda', operations: ['Invoke'] }],
  provenance: 'test-signed table',
};

interface BillingWorld {
  readonly world: RunnerWorld;
  readonly account: string;
  readonly provider: string;
  readonly hour: string;
}

async function finishedRun(): Promise<BillingWorld> {
  const world = await RunnerWorld.create();
  await world.run();
  const closure = await readPackageClosure(world.cloud.storage, world.admitted, lifecycleValidator());
  assert.ok(closure.ok && closure.value.first_mutation_at !== undefined);
  const manifest = JSON.parse(new TextDecoder().decode(world.resourceManifestBytes)) as ResourceManifest;
  const hour = new Date(Math.floor(Date.parse(closure.value.first_mutation_at) / 3_600_000) * 3_600_000);
  return {
    world,
    account: world.admitted.manifest.environment.account_id,
    provider: manifest.resources[0]?.physical_id ?? '',
    hour: hour.toISOString().replace('.000Z', 'Z'),
  };
}

function dataFile(billing: BillingWorld): Uint8Array {
  const end = new Date(Date.parse(billing.hour) + 3_600_000).toISOString().replace('.000Z', 'Z');
  return csvBytes(
    curCsv([
      curRecord({
        [CUR_LINE_COLUMNS.usage_account_id]: billing.account,
        [CUR_LINE_COLUMNS.resource_id]: billing.provider,
        [CUR_LINE_COLUMNS.run_tag]: executionIdOf(billing.world.admitted.identity),
        [CUR_LINE_COLUMNS.usage_start]: billing.hour,
        [CUR_LINE_COLUMNS.usage_end]: end,
        [CUR_PERIOD_COLUMNS.start]: '2026-10-01T00:00:00Z',
        [CUR_PERIOD_COLUMNS.end]: '2026-11-01T00:00:00Z',
      }),
    ]),
  );
}

function delivery(billing: BillingWorld, data: Uint8Array = dataFile(billing)): readonly DeliveryEntry[] {
  const manifest = {
    dataFiles: [`s3://suc-cur/exports/${DATA_PATH}`],
    billingPeriod: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
    account: billing.account,
    usageAccountIds: [billing.account],
  };
  return [
    { path: MANIFEST_PATH, bytes: new TextEncoder().encode(JSON.stringify(manifest)) },
    { path: DATA_PATH, bytes: data },
  ];
}

async function importBilling(
  billing: BillingWorld,
  entries: readonly DeliveryEntry[] | undefined,
  facts: BillingFactTable = OWNER_SIGNED_BILLING_FACTS,
  files: PackageFileSystem = billing.world.cloud.storage,
): Promise<CliRun> {
  const deliveries = new MemoryDeliveryDirectory();
  if (entries !== undefined) {
    deliveries.place(DELIVERY_DIR, entries);
  }
  const command = new BillingImportCommand({
    files: (): PackageFileSystem => files,
    deliveries,
    facts,
    services: billing.world.services,
  });
  const argv = [
    'billing',
    'import',
    packageOperand(billing.world.admitted.identity),
    '--export',
    'cur/2026-10',
    '--evidence-root',
    STORED_EVIDENCE_ROOT,
  ];
  return runCli(argv, [command]);
}

function amendmentFiles(world: RunnerWorld, written: string): ReadonlyMap<string, Uint8Array> {
  const directory = written.slice(0, -`/${AMENDMENT_PATHS.amendmentIndex}`.length);
  return world.cloud.storage.filesUnder(directory);
}

describe('billing import', () => {
  it('writes an unverified BILLING amendment with the delivery bytes under the facts in force', async () => {
    const billing = await finishedRun();
    const entries = delivery(billing);
    const run = await importBilling(billing, entries);
    assert.equal(run.exit_code, 0, JSON.stringify(run.result.reasons));
    assert.equal(run.result.run_id, executionIdOf(billing.world.admitted.identity));
    const [written] = run.result.written_paths;
    assert.match(
      written ?? '',
      new RegExp(
        `^${PACKAGE_LAYOUT.amendmentsDirectory(billing.world.admitted.identity)}/0001-[^/]+/amendment-index\\.json$`,
      ),
    );
    const record = run.result.result_record ?? {};
    assert.equal(record['billed_cost_check'], 'unverified');
    assert.equal('attributed_total_usd' in record, false);
    assert.deepEqual(
      (record['reasons'] as readonly JsonObject[]).map((reason) => reason['code']),
      // The empty allowlist, the line it leaves unattributed, and that line's own exclusion.
      ['INCOMPLETE_ATTRIBUTION', 'INCOMPLETE_ATTRIBUTION', 'SHARED_OR_UNOWNED_CHARGE'],
    );
    assert.equal(record['ceiling_usd'], billing.world.admitted.manifest.safety.ceiling_usd);
    const files = amendmentFiles(billing.world, written ?? '');
    assert.deepEqual(files.get(`payload/billing-export/${MANIFEST_PATH}`), entries[0]?.bytes);
    assert.deepEqual(files.get(`payload/billing-export/${DATA_PATH}`), entries[1]?.bytes);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(files.get(AMENDMENT_PATHS.billingImport))), record);
    const index = JSON.parse(new TextDecoder().decode(files.get(AMENDMENT_PATHS.amendmentIndex))) as JsonObject;
    assert.equal(index['amendment_kind'], 'BILLING');
    assert.deepEqual(run.stderr_lines, [
      `billed-cost check unverified for ${billing.world.admitted.package_directory}`,
    ]);
  });

  it('attributes the line and stays conclusive only under a signed allowlist and a covering delivery', async () => {
    const billing = await finishedRun();
    const run = await importBilling(billing, delivery(billing), SIGNED);
    assert.equal(run.exit_code, 0, JSON.stringify(run.result.reasons));
    assert.equal(run.result.result_record?.['billed_cost_check'], 'within_limit');
    assert.equal(run.result.result_record['attributed_total_usd'], '0.5');
  });

  it('demotes a delivery whose scope omits the frozen account', async () => {
    const billing = await finishedRun();
    const [manifest, data] = delivery(billing);
    const scoped = JSON.parse(new TextDecoder().decode(manifest?.bytes)) as JsonObject;
    const entries = [
      {
        path: MANIFEST_PATH,
        bytes: new TextEncoder().encode(JSON.stringify({ ...scoped, account: '999999999999', usageAccountIds: [] })),
      },
      data ?? { path: DATA_PATH },
    ];
    const run = await importBilling(billing, entries, SIGNED);
    assert.equal(run.exit_code, 0);
    assert.equal(run.result.result_record?.['billed_cost_check'], 'unverified');
  });

  it('refuses a delivery that is not one manifest and its one data file, writing nothing', async () => {
    const billing = await finishedRun();
    const run = await importBilling(billing, [
      ...delivery(billing),
      { path: 'data/extra.csv', bytes: new Uint8Array([1]) },
    ]);
    assert.equal(run.exit_code, 5);
    assert.deepEqual(
      run.result.reasons.map((reason) => reason.code),
      ['BILLING_DELIVERY_REFUSED'],
    );
    assert.equal(
      billing.world.cloud.storage.filesUnder(PACKAGE_LAYOUT.amendmentsDirectory(billing.world.admitted.identity)).size,
      0,
    );
  });

  it('refuses an export that does not parse as CUR, writing nothing', async () => {
    const billing = await finishedRun();
    const run = await importBilling(billing, delivery(billing, new TextEncoder().encode('not,a\ncur')));
    assert.equal(run.exit_code, 5);
    assert.equal(run.result.written_paths.length, 0);
    assert.ok(run.result.reasons.length > 0);
  });

  it('refuses a package that records no first mutation', async () => {
    const billing = await finishedRun();
    const storage = new OfflinePackageStorage();
    const journal = `${billing.world.admitted.package_directory}/${EXECUTION_PATHS.runnerJournal}`;
    await copyEvidence(billing.world, storage, (path, bytes) => (path === journal ? undefined : bytes));
    const run = await importBilling(billing, delivery(billing), OWNER_SIGNED_BILLING_FACTS, storage);
    assert.equal(run.exit_code, 5);
    assert.deepEqual(
      run.result.reasons.map((reason) => reason.code),
      ['BILLING_WINDOW_UNKNOWN'],
    );
  });

  it('refuses an unfinalized package and an unreadable delivery directory', async () => {
    const fresh = await RunnerWorld.create();
    const unfinalized = await importBilling(
      { world: fresh, account: '012345678901', provider: '', hour: '2026-10-05T12:00:00Z' },
      [],
    );
    assert.equal(unfinalized.exit_code, 5);
    assert.deepEqual(
      unfinalized.result.reasons.map((reason) => reason.code),
      ['PACKAGE_NOT_FINALIZED'],
    );
    const billing = await finishedRun();
    const unreadable = await importBilling(billing, undefined);
    assert.equal(unreadable.exit_code, 2);
    assert.equal(
      unreadable.result.reasons[0]?.detail,
      `--export "${DELIVERY_DIR}" cannot be read (ENOENT: ENOENT: no such file or directory, scandir '${DELIVERY_DIR}'); expected a readable delivery directory`,
    );
  });

  it('refuses an operand that is not a package directory as a usage error', async () => {
    const world = await RunnerWorld.create();
    const command = new BillingImportCommand({
      files: (): PackageFileSystem => world.cloud.storage,
      deliveries: new MemoryDeliveryDirectory(),
      facts: OWNER_SIGNED_BILLING_FACTS,
      services: world.services,
    });
    const run = await runCli(
      ['billing', 'import', '/elsewhere/runs/x', '--export', 'cur', '--evidence-root', STORED_EVIDENCE_ROOT],
      [command],
    );
    assert.equal(run.exit_code, 2);
  });

  it('is an evidence failure when the amendment could not be stored', async () => {
    const billing = await finishedRun();
    const storage = new RefusingPackageStorage();
    await copyEvidence(billing.world, storage);
    storage.refuseWritesUnder(`${PACKAGE_LAYOUT.amendmentsDirectory(billing.world.admitted.identity)}/`);
    const run = await importBilling(billing, delivery(billing), OWNER_SIGNED_BILLING_FACTS, storage);
    assert.equal(run.exit_code, 10);
    assert.equal(run.result.reasons[0]?.code, 'AMENDMENT_NOT_WRITTEN');
  });
});
