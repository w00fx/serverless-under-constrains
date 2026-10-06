// The leak audit (BR-RUA-051, design §8.18, §9.14; cleanup steps 10-11). Two complete passes
// over every discovery surface, at least 120 s apart, each judging every resource it sees with
// the BR-RUA-050 ownership rules:
// - an owned resource still observed is a leak, with its D-30 capability class;
// - a resource of unproven ownership is reported ambiguous, never deleted and never a leak;
// - a baseline resource is ignored.
//
// The wait between passes is measured on the monotonic clock and re-armed until 120 s have
// really elapsed, because timers may fire early (RK-03) and the wall clock may step. When the
// sleeper never lets that much time pass, the second pass is not run, and one pass is
// `inconclusive` by definition.
//
// Every pass that observes an owned resource reports it, even when a later pass no longer sees
// it: absence that is not stable for the whole audit is not proven. Such a lagging deletion
// makes this audit `leaks_detected`; a later cleanup run audits again (AC-RUA-011).

import { executionIdentityFields } from '../record-contract/envelope.ts';
import type {
  ExecutionIdentity,
  MonotonicClock,
  Sha256Hex,
  Sleeper,
  WallClock,
} from '../record-contract/primitives.ts';
import type {
  AmbiguousResource,
  AuditPass,
  LeakAuditResult,
  LeakedResource,
} from '../record-contract/records/group-c/leak_audit_result.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { DiscoverySurfaces } from './discovery.ts';
import { classifyLeakCapability } from './leak-capability.ts';
import { deriveLeakAuditStatus, STABLE_ABSENCE_MS } from './operational-statuses.ts';
import type { OwnershipContext } from './ownership-context.ts';
import type { JudgedResource } from './ownership-judgement.ts';
import { judgeOwnership } from './ownership-judgement.ts';
import { resourceKey } from './resource-names.ts';
import type { SurfaceSighting } from './surface-sweep.ts';
import { sweepSurfaces } from './surface-sweep.ts';

/** How often the wait between passes re-arms before the second pass is given up. */
export const MAX_STABILITY_SLEEPS = 8;

const NS_PER_MS = 1_000_000n;

export interface LeakAuditorDeps {
  readonly surfaces: DiscoverySurfaces;
  readonly clock: WallClock;
  readonly monotonic: MonotonicClock;
  readonly sleeper: Sleeper;
}

export interface AuditInput {
  readonly execution: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly ownership: OwnershipContext;
}

interface PassFindings {
  readonly pass: AuditPass;
  readonly leaks: readonly LeakedResource[];
  readonly ambiguous: readonly AmbiguousResource[];
}

/**
 * Audits every discovery surface for owned resources that cleanup left behind.
 *
 * @example
 * const auditor = new LeakAuditor({ surfaces, clock, monotonic, sleeper });
 * const result = await auditor.audit({ execution, execution_manifest_sha256, ownership });
 * result.leak_audit_status; // 'clean' after two absent passes 120 s apart
 */
export class LeakAuditor {
  readonly #deps: LeakAuditorDeps;

  constructor(deps: LeakAuditorDeps) {
    this.#deps = deps;
  }

  /** Runs the passes and returns the `leak_audit_result` record; never throws on surface failures. */
  async audit(input: AuditInput): Promise<LeakAuditResult> {
    const first = await this.#runPass(input.ownership);
    const interval = await this.#waitForStableAbsence(this.#deps.monotonic.nowNs());
    const findings = interval === undefined ? [first] : [first, await this.#runPass(input.ownership)];
    const leaks = uniqueByResource(findings.flatMap((finding) => finding.leaks));
    const ambiguous = uniqueByResource(findings.flatMap((finding) => finding.ambiguous));
    const passes = findings.map((finding) => finding.pass);
    const stableAbsenceMs = interval ?? 0;
    return {
      schema_version: 1,
      record_type: 'leak_audit_result',
      ...executionIdentityFields(input.execution),
      execution_manifest_sha256: input.execution_manifest_sha256,
      leak_audit_status: deriveLeakAuditStatus({
        passes,
        leak_count: leaks.length,
        ambiguous_count: ambiguous.length,
        stable_absence_interval_ms: stableAbsenceMs,
      }),
      passes,
      leaks,
      ambiguous,
      stable_absence_interval_ms: stableAbsenceMs,
      audited_at: formatUtcMillis(this.#deps.clock.now()),
    };
  }

  async #runPass(ownership: OwnershipContext): Promise<PassFindings> {
    const startedAt = formatUtcMillis(this.#deps.clock.now());
    const sightings = await sweepSurfaces(this.#deps.surfaces);
    const judged = judgeOwnership(
      sightings.flatMap((sighting) => sighting.resources),
      ownership,
    );
    return {
      pass: {
        started_at: startedAt,
        completed_at: formatUtcMillis(this.#deps.clock.now()),
        surfaces: sightings.map((sighting) => ({
          surface: sighting.surface,
          query_ok: sighting.query_ok,
          observed: ownedIdentifiers(sighting, judged),
        })),
      },
      leaks: [...judged.values()].flatMap(toLeak),
      ambiguous: [...judged.values()].flatMap(toAmbiguous),
    };
  }

  // Milliseconds elapsed since `fromNs` once at least STABLE_ABSENCE_MS have passed, or
  // undefined when MAX_STABILITY_SLEEPS sleeps never got there.
  async #waitForStableAbsence(fromNs: bigint): Promise<number | undefined> {
    for (let sleeps = 0; sleeps <= MAX_STABILITY_SLEEPS; sleeps += 1) {
      const elapsedMs = Number((this.#deps.monotonic.nowNs() - fromNs) / NS_PER_MS);
      if (elapsedMs >= STABLE_ABSENCE_MS) {
        return elapsedMs;
      }
      if (sleeps < MAX_STABILITY_SLEEPS) {
        await this.#deps.sleeper.sleep(STABLE_ABSENCE_MS - elapsedMs);
      }
    }
    return undefined;
  }
}

// The identifiers a surface saw whose resource is owned: the run-owned resources it still observes.
function ownedIdentifiers(sighting: SurfaceSighting, judged: ReadonlyMap<string, JudgedResource>): string[] {
  const owned = sighting.resources.filter((resource) => judged.get(resourceKey(resource))?.decision.kind === 'owned');
  return [...new Set(owned.map((resource) => resource.identifier))].sort();
}

function toLeak({ resource, decision }: JudgedResource): LeakedResource[] {
  if (decision.kind !== 'owned') {
    return [];
  }
  return [
    {
      resource_type: resource.resource_type,
      identifier: resource.identifier,
      surface: resource.surface,
      capability_class: classifyLeakCapability(resource),
      ownership_basis: decision.basis,
    },
  ];
}

function toAmbiguous({ resource, decision }: JudgedResource): AmbiguousResource[] {
  if (decision.kind !== 'ambiguous') {
    return [];
  }
  return [
    {
      resource_type: resource.resource_type,
      identifier: resource.identifier,
      surface: resource.surface,
      reasons: decision.reasons,
    },
  ];
}

function uniqueByResource<T extends { readonly resource_type: string; readonly identifier: string }>(
  entries: readonly T[],
): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = resourceKey(entry);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
