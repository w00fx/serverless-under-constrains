// Runner-produced packages and the package verifier (CMP-05 R1; Owner amendment A-15, decision 80;
// BR-RUA-035, BR-RUA-044; design §8.16 step 4). Every frozen oracle result and the transport probe
// result cite `runner/runner-journal.jsonl` with the digest the journal had at freeze time, and the
// runner keeps appending through P6-P9. Before A-15 each such reference was UNRESOLVED_REFERENCE
// (three per trial, one for the probe result), so no runner package was ever eligible and no probe
// was ever usable. This is the boundary where the defect occurred: the real runner writes the
// package, the real snapshot reader reads it back, and the real verifier judges it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ExecutionOutcome } from '../../../src/execution-lifecycle/execution-ports.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import { readPackageSnapshot } from '../../../src/evidence-package/package-snapshot.ts';
import type { PackageSnapshot } from '../../../src/evidence-package/package-verifier.ts';
import { verifyPackage } from '../../../src/evidence-package/package-verifier.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { isJsonArray, isJsonObject } from '../../../src/record-contract/json-value.ts';
import type { ExecutionIdentity, JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import type { PackageVerification } from '../../../src/record-contract/records/group-c/package_verification.ts';
import { formatUtcMillis } from '../../../src/record-contract/timestamps.ts';
import type { OfflinePackageStorage } from '../../support/offline-cloud/offline-package-storage.ts';
import { lifecycleValidator } from './support/execution-fixtures.ts';
import { ProbeRunnerWorld } from './support/probe-runner-world.ts';
import { RunnerWorld } from './support/runner-world.ts';

const RUNNER_JOURNAL = EXECUTION_PATHS.runnerJournal;
const decoder = new TextDecoder();

interface VerifiedRunnerPackage {
  readonly outcome: ExecutionOutcome;
  readonly snapshot: PackageSnapshot;
  readonly verification: PackageVerification;
}

async function verifiedPackage(
  storage: OfflinePackageStorage,
  identity: ExecutionIdentity,
  outcome: ExecutionOutcome,
  now: Date,
): Promise<VerifiedRunnerPackage> {
  const snapshot = await readPackageSnapshot(storage, identity);
  assert.ok(snapshot.ok, 'the finalized package reads back');
  const verification = verifyPackage(
    {
      identity,
      original: snapshot.value,
      amendments: [],
      selected_head: null,
      referenced_package_indexes: [],
      evaluated_at: formatUtcMillis(now),
    },
    { validator: lifecycleValidator(), digest: sha256Hex },
  );
  return { outcome, snapshot: snapshot.value, verification };
}

function bytesAt(snapshot: PackageSnapshot, path: string): Uint8Array {
  const file = snapshot.files.find((candidate) => candidate.path === path);
  assert.ok(file !== undefined, `${path} is in the package`);
  return file.bytes;
}

function recordAt(snapshot: PackageSnapshot, path: string): JsonObject {
  return JSON.parse(decoder.decode(bytesAt(snapshot, path))) as JsonObject;
}

// The distinct runner-journal references of a record: objects naming the path and a digest (a
// structured reason names the path without a digest and is not a reference; a result repeats a
// reference in its conditions, so the same object can occur more than once).
function runnerJournalRefs(record: JsonValue): readonly JsonObject[] {
  const found = new Map<string, JsonObject>();
  const pending: JsonValue[] = [record];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    pending.push(...(isJsonArray(next) ? next : isJsonObject(next) ? Object.values(next) : []));
    if (isRunnerJournalRef(next)) {
      found.set(JSON.stringify(next), next);
    }
  }
  return [...found.values()];
}

function isRunnerJournalRef(value: JsonValue): value is JsonObject {
  return (
    isJsonObject(value) && value['artifact_path'] === RUNNER_JOURNAL && typeof value['artifact_sha256'] === 'string'
  );
}

const ASSEMBLY_PREFIX = 'admission/deployment-assembly';

// The offline clouds freeze the record contract's canonical deployment-assembly inventory (its
// inventory_sha256 is a placeholder) and store none of the assembly files it lists; a real
// admission writes both (src/admission/package-draft.ts). Those ALTERED_BYTES reasons are fixture
// artifacts, so they are the only reasons tolerated here; any other reason fails.
function nonFixtureReasons(verification: PackageVerification): readonly string[] {
  return verification.package_ineligibility_reasons
    .filter((reason) => reason.code !== 'ALTERED_BYTES' || !(reason.artifact_path ?? '').startsWith(ASSEMBLY_PREFIX))
    .map((reason) => `${reason.code}: ${reason.detail}`);
}

function runnerJournalReasons(verification: PackageVerification): readonly string[] {
  return verification.package_ineligibility_reasons
    .filter((reason) => reason.code === 'UNRESOLVED_REFERENCE' && reason.detail.includes(RUNNER_JOURNAL))
    .map((reason) => reason.detail);
}

// Each cited digest is a strict, newline-terminated prefix of the final journal: the premise A-15
// rests on, checked on the real bytes so the fix is not resolving a reference by accident.
function assertCitesAStrictLinePrefix(snapshot: PackageSnapshot, refs: readonly JsonObject[]): void {
  const journal = bytesAt(snapshot, RUNNER_JOURNAL);
  const boundaries = [...journal.keys()].filter((index) => journal[index] === 0x0a).map((index) => index + 1);
  for (const reference of refs) {
    const cited = reference['artifact_sha256'];
    const length = boundaries.find((end) => sha256Hex(journal.subarray(0, end)) === cited);
    assert.ok(length !== undefined, `${JSON.stringify(cited)} is the digest of a line-boundary prefix`);
    assert.ok(length < journal.length, 'the journal grew after the freeze');
    const eventId = reference['event_id'];
    if (typeof eventId === 'string') {
      assert.ok(decoder.decode(journal.subarray(0, length)).includes(eventId), 'the event is inside the prefix');
    }
  }
}

describe('CMP-05 R1 (A-15) a run package cites its runner journal by a resolvable prefix', async () => {
  const world = await RunnerWorld.create();
  const outcome = await world.run();
  const verified = await verifiedPackage(world.cloud.storage, world.admitted.identity, outcome, world.cloud.time.now());

  it('freezes trials whose oracle results cite earlier runner-journal prefixes', () => {
    assert.equal(verified.outcome.package_finalized, true);
    assert.ok(verified.outcome.trials.length > 0, 'the run executes trials');
    for (const trial of verified.outcome.trials) {
      const path = PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: trial.trial_id }, 'oracleResult');
      const refs = runnerJournalRefs(recordAt(verified.snapshot, path));
      assert.equal(refs.length, 3, `${path} cites three distinct runner-journal references`);
      assertCitesAStrictLinePrefix(verified.snapshot, refs);
    }
  });

  it('reports no UNRESOLVED_REFERENCE naming the runner journal', () => {
    assert.deepEqual(runnerJournalReasons(verified.verification), []);
  });

  it('reports no reason beyond the offline deployment-assembly fixture', () => {
    assert.deepEqual(nonFixtureReasons(verified.verification), []);
  });
});

describe('CMP-05 R1 (A-15) a probe package cites its runner journal by a resolvable prefix', async () => {
  const world = await ProbeRunnerWorld.create();
  const outcome = await world.run();
  const verified = await verifiedPackage(world.cloud.storage, world.admitted.identity, outcome, world.cloud.time.now());

  it('freezes a probe result that cites an earlier runner-journal prefix', () => {
    assert.equal(verified.outcome.package_finalized, true);
    const path = PACKAGE_LAYOUT.unitFile({ kind: 'probe' }, 'transportProbeResult');
    const refs = runnerJournalRefs(recordAt(verified.snapshot, path));
    assert.equal(refs.length, 1, `${path} cites the runner journal once`);
    assertCitesAStrictLinePrefix(verified.snapshot, refs);
  });

  it('reports no UNRESOLVED_REFERENCE naming the runner journal', () => {
    assert.deepEqual(runnerJournalReasons(verified.verification), []);
  });

  it('reports no reason beyond the offline deployment-assembly fixture', () => {
    assert.deepEqual(nonFixtureReasons(verified.verification), []);
  });
});
