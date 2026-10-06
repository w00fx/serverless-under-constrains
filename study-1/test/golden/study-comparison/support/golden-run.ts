// The study-comparison pipeline as the golden tests drive it over committed fixture bytes: read the
// run package, finalize its comparison and summary (design §10.2 P9), seal it with the WP-13 package
// index, and verify it with the WP-13 verifier. Each step is the production code; only the
// deployment projection is supplied here, because no construct path exists yet to read it from the
// frozen template (evidence/WP-16/decisions.md).

import { serializeRecordFile } from '../../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { JsonObject, Sha256Hex, UtcMillis } from '../../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import type { PackageVerification } from '../../../../src/record-contract/records/group-c/package_verification.ts';
import type { AmendmentSnapshot } from '../../../../src/evidence-package/amendment-snapshots.ts';
import { buildPackageIndex } from '../../../../src/evidence-package/package-index.ts';
import { EXECUTION_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import { verifyPackage } from '../../../../src/evidence-package/package-verifier.ts';
import type { DeploymentProjection, VariantDeploymentSheet } from '../../../../src/study-comparison/equality-sheets.ts';
import { finalizeRunAssessments } from '../../../../src/study-comparison/run-package-assessment.ts';
import type { FinalizedRunFiles } from '../../../../src/study-comparison/run-package-assessment.ts';
import { readRunPackage } from '../../../../src/study-comparison/run-package-reader.ts';
import type { RunPackageRecords } from '../../../../src/study-comparison/run-package-reader.ts';
import type { FixtureBytes } from '../../../support/golden-builder/digest-links.ts';
import { RUN_ID } from './run-fixture.ts';

/** The catalogue validator and the production digest. */
export const GOLDEN_DEPS = { validator: createRecordValidator(), digest: sha256Hex } as const;

/** When the golden run finalizes, seals and is verified. */
export const FINALIZED_AT = '2026-10-05T13:15:00.000Z' as UtcMillis;
export const SEALED_AT = '2026-10-05T13:16:00.000Z' as UtcMillis;
export const VERIFIED_AT = '2026-10-06T09:00:00.000Z' as UtcMillis;

const RUN_IDENTITY = { execution_kind: 'RUN', run_id: RUN_ID } as const;

/** The values both variants share in the inventoried template (design §8.14 table, OR-RUA-001/002). */
const SHARED_TEMPLATE: Omit<VariantDeploymentSheet, 'caller_strategy'> = {
  message_source_protocol: {
    fifo: true,
    batch_size: 1,
    maximum_batching_window_s: 0,
    provisioned_poller: false,
    scaling_config: false,
    dead_letter_queue_fifo: true,
    target_qualifier: 'alias',
  },
  provider_configuration: {
    runtime: 'nodejs24.x',
    architecture: 'arm64',
    memory_mb: 512,
    timeout_s: 30,
    environment_keys: ['LEDGER_TABLE', 'PROVIDER_JOURNAL_TABLE', 'TREATMENT_TABLE'],
  },
  controller_configuration: {
    stream_view_type: 'NEW_IMAGE',
    starting_position: 'LATEST',
    batch_size: 1,
    filter: 'INSERT',
  },
  caller_timing: { http_handler: { request_timeout_ms: 3000, keep_alive: false } },
};

/** The Durable strategy's own settings (design §8.14 `caller_timing` declared differences). */
const DURABLE_STRATEGY: JsonObject = { execution_retention_days: 1, execution_strategy: 'durable_step_retry' };
const CONVENTIONAL_STRATEGY: JsonObject = { execution_strategy: 'sqs_redelivery' };

/**
 * The projection of the frozen template, citing the manifest's pin of that template.
 *
 * @example
 * specDeploymentProjection(sha256Hex(files.get('admission/execution-manifest.json')));
 */
export function specDeploymentProjection(manifestSha256: Sha256Hex): DeploymentProjection {
  return {
    variants: {
      conventional: { ...SHARED_TEMPLATE, caller_strategy: CONVENTIONAL_STRATEGY },
      durable: { ...SHARED_TEMPLATE, caller_strategy: DURABLE_STRATEGY },
    },
    evidence_refs: [
      {
        artifact_path: EXECUTION_PATHS.executionManifest,
        artifact_sha256: manifestSha256,
        json_pointer: '/deployment_assembly',
      },
    ],
  };
}

/**
 * Reads the run package of a fixture; throws when it cannot (a broken fixture, not a finding).
 *
 * @example
 * const records = readGoldenRun(loaded.files);
 */
export function readGoldenRun(files: FixtureBytes): RunPackageRecords {
  const read = readRunPackage(files, GOLDEN_DEPS);
  if (!read.ok) {
    throw new Error(`the fixture is not a readable run package: ${JSON.stringify(read.error)}`);
  }
  return read.value;
}

/** A finalized run: what finalization read, what it wrote, and the package with its summary files. */
export interface FinalizedGoldenRun {
  readonly records: RunPackageRecords;
  readonly finalized: FinalizedRunFiles;
  readonly files: FixtureBytes;
}

/**
 * Finalizes the fixture's run with the spec deployment projection; throws when it cannot.
 *
 * @example
 * finalizeGoldenRun(loaded.files).finalized.run_summary.record.trial_results.length; // 4
 */
export function finalizeGoldenRun(files: FixtureBytes): FinalizedGoldenRun {
  const records = readGoldenRun(files);
  const deployment = specDeploymentProjection(records.execution_manifest.ref.artifact_sha256);
  const finalized = finalizeRunAssessments(
    records,
    { deployment, contradictory_amendments: [], finalized_at: FINALIZED_AT },
    sha256Hex,
  );
  if (!finalized.ok) {
    throw new Error(`the fixture run cannot be finalized: ${JSON.stringify(finalized.error)}`);
  }
  const withSummary = new Map(files);
  withSummary.set(finalized.value.comparison_assessment.path, finalized.value.comparison_assessment.bytes);
  withSummary.set(finalized.value.run_summary.path, finalized.value.run_summary.bytes);
  return { records, finalized: finalized.value, files: withSummary };
}

/** A sealed original package and the digest of its index. */
export interface SealedGoldenRun {
  readonly files: FixtureBytes;
  readonly package_index_sha256: Sha256Hex;
}

/**
 * Writes the final package index over every file (BR-RUA-044); throws when it cannot be built.
 *
 * @example
 * const sealed = sealGoldenRun(finalizeGoldenRun(loaded.files).files);
 */
export function sealGoldenRun(files: FixtureBytes): SealedGoldenRun {
  const index = buildPackageIndex({
    files: [...files].map(([path, bytes]) => ({ path, bytes })),
    identity: RUN_IDENTITY,
    created_at: SEALED_AT,
  });
  if (!index.ok) {
    throw new Error(`the package index cannot be built: ${JSON.stringify(index.error)}`);
  }
  const bytes = serializeRecordFile(index.value);
  const sealed = new Map(files);
  sealed.set(EXECUTION_PATHS.packageIndex, bytes);
  return { files: sealed, package_index_sha256: sha256Hex(bytes) };
}

/**
 * Verifies a sealed package with the WP-13 verifier and its selected amendment chain.
 *
 * @example
 * verifyGoldenRun(sealed.files, [], null).package_eligibility; // 'eligible'
 */
export function verifyGoldenRun(
  files: FixtureBytes,
  amendments: readonly AmendmentSnapshot[],
  selectedHead: Sha256Hex | null,
): PackageVerification {
  return verifyPackage(
    {
      identity: RUN_IDENTITY,
      original: { files: [...files].map(([path, bytes]) => ({ path, bytes })), special_entries: [] },
      amendments,
      selected_head: selectedHead,
      referenced_package_indexes: [],
      evaluated_at: VERIFIED_AT,
    },
    GOLDEN_DEPS,
  );
}
