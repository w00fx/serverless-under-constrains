// The plan of the late-record capture at cleanup step 1 (BR-RUA-043; design §10.4 step 1, §8.13):
// every frozen unit of the execution and what it was collected from, with the exact bytes it froze,
// for `captureLateRecords` (evidence-collection) to re-read and compare by identity. A unit is
// frozen when its evidence index exists (T11 wrote it last). A queued trial is re-read from its
// variant's DLQ; a Durable trial's listing is the one its frozen `durable-executions.json` records
// (function, version and publication instant), so the re-read lists exactly what the freeze listed.
// The execution-level frozen copies are the readiness and A-09 provider journals the runner packaged
// before cleanup. Pure: it only reads the given files.

import type { CaptureUnit } from '../evidence-collection/capture-scope.ts';
import type { CollectedFileKey } from '../evidence-collection/collection-buffer.ts';
import type { DurableListingRequest } from '../evidence-collection/durable-metadata.ts';
import type { FrozenArtifacts, LateCapturePlan, LateCaptureUnit } from '../evidence-collection/late-record-capture.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import type { EvidenceUnit } from '../evidence-package/package-layout.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import type { JsonValue } from '../record-contract/primitives.ts';
import { isUtcMillis } from '../record-contract/timestamps.ts';
import type { AdmittedExecution, ExecutionTargets } from './execution-ports.ts';

type PackageFiles = ReadonlyMap<string, Uint8Array>;

/** The unit files a capture compares its re-reads with. */
const UNIT_FROZEN_KEYS = [
  'callerJournal',
  'providerJournal',
  'controllerJournal',
  'ledgerSnapshot',
  'dlqSnapshot',
  'durableExecutions',
] as const satisfies readonly CollectedFileKey[];

/** The execution-level journals a capture compares its re-reads with. */
const EXECUTION_FROZEN_KEYS = [
  'canaryCallerJournal',
  'canaryControllerJournal',
  'warmupProviderJournal',
  'executionProviderJournal',
] as const satisfies readonly CollectedFileKey[];

/**
 * The capture plan of every frozen unit of `admitted`'s package.
 *
 * @example
 * const plan = lateCapturePlan(filesByPath(files), admitted, targets);
 * plan.units.map((unit) => unit.unit.kind); // ['trial', 'trial', 'trial', 'trial'] after a full run
 */
export function lateCapturePlan(
  files: PackageFiles,
  admitted: AdmittedExecution,
  targets: ExecutionTargets | undefined,
): LateCapturePlan {
  return {
    execution: admitted.identity,
    execution_manifest_sha256: admitted.manifest_sha256,
    units: frozenUnits(files, admitted, targets),
    execution_frozen: frozenCopies(files, EXECUTION_FROZEN_KEYS, (key) => EXECUTION_PATHS[key]),
  };
}

function frozenUnits(
  files: PackageFiles,
  admitted: AdmittedExecution,
  targets: ExecutionTargets | undefined,
): readonly LateCaptureUnit[] {
  if (admitted.identity.execution_kind === 'TRANSPORT_PROBE') {
    const probe: EvidenceUnit = { kind: 'probe' };
    return isFrozen(files, probe) ? [{ unit: probe, frozen: unitCopies(files, probe) }] : [];
  }
  return admitted.manifest.trials.flatMap((trial) => {
    const unit: EvidenceUnit = { kind: 'trial', trial_id: trial.trial_id };
    const manifest = files.get(PACKAGE_LAYOUT.unitFile(unit, 'trialManifest'));
    if (manifest === undefined || !isFrozen(files, unit)) {
      return [];
    }
    const capture: CaptureUnit = { ...unit, trial_manifest_sha256: sha256Hex(manifest) };
    const dlq = targets?.queues[trial.variant_id]?.dlq;
    const durable = frozenListing(files.get(PACKAGE_LAYOUT.unitFile(unit, 'durableExecutions')));
    return [
      {
        unit: capture,
        ...(dlq === undefined ? {} : { dlq }),
        ...(durable === undefined ? {} : { durable }),
        frozen: unitCopies(files, unit),
      },
    ];
  });
}

function isFrozen(files: PackageFiles, unit: EvidenceUnit): boolean {
  return files.has(PACKAGE_LAYOUT.unitFile(unit, 'evidenceIndex'));
}

function unitCopies(files: PackageFiles, unit: EvidenceUnit): FrozenArtifacts {
  return frozenCopies(files, UNIT_FROZEN_KEYS, (key) => PACKAGE_LAYOUT.unitFile(unit, key));
}

function frozenCopies<K extends CollectedFileKey>(
  files: PackageFiles,
  keys: readonly K[],
  pathOf: (key: K) => string,
): FrozenArtifacts {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const bytes = files.get(pathOf(key));
      return bytes === undefined ? [] : [[key, bytes]];
    }),
  );
}

// The listing request a frozen `durable_execution_metadata` record names, or undefined when the
// trial froze none or the record cannot be read (then nothing is re-listed).
function frozenListing(bytes: Uint8Array | undefined): DurableListingRequest | undefined {
  const parsed = bytes === undefined ? undefined : parseJsonDocument(bytes);
  if (parsed?.ok !== true) {
    return undefined;
  }
  const functionArn = ownText(parsed.value, 'function_arn');
  const qualifier = ownText(parsed.value, 'qualifier');
  const startedAfter = ownText(parsed.value, 'started_after');
  if (
    functionArn === undefined ||
    qualifier === undefined ||
    startedAfter === undefined ||
    !isUtcMillis(startedAfter)
  ) {
    return undefined;
  }
  return { function_arn: functionArn, qualifier, started_after: startedAfter };
}

function ownText(value: JsonValue, name: string): string | undefined {
  const member = isJsonObject(value) && Object.hasOwn(value, name) ? value[name] : undefined;
  return typeof member === 'string' ? member : undefined;
}
