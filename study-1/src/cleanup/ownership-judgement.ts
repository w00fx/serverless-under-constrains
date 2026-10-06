// One ownership decision per resource across every surface that saw it (BR-RUA-050). Surfaces
// carry different evidence about the same resource: the stack listing proves only the stack
// boundary, while the native surface reads the tags that allow direct deletion. The decision
// kept is the strongest evidence, in this order:
// 1. baseline on any surface: never touched, whatever else a surface says;
// 2. a basis that allows direct deletion (manifest and tags, or the partial-manifest rule);
// 3. the recorded-stack boundary;
// 4. ambiguous, when no surface proved ownership.
// Ties keep the first sighting in surface order.

import type { DiscoveredResource } from './discovery.ts';
import type { OwnershipContext } from './ownership-context.ts';
import type { OwnershipDecision } from './ownership.ts';
import { isDirectlyDeletable, proveOwnership } from './ownership.ts';
import { resourceKey } from './resource-names.ts';

export interface JudgedResource {
  readonly resource: DiscoveredResource;
  readonly decision: OwnershipDecision;
}

/**
 * Judges every sighting and keeps, per resource, the decision with the strongest evidence.
 * The map is keyed by `resourceKey` in first-sighting order.
 *
 * @example
 * const judged = judgeOwnership(sightings.flatMap((sighting) => sighting.resources), context);
 * judged.get('AWS::Lambda::Function|suc1-3f1c2a9e-provider')?.decision.kind; // 'owned'
 */
export function judgeOwnership(
  resources: readonly DiscoveredResource[],
  context: OwnershipContext,
): ReadonlyMap<string, JudgedResource> {
  const judged = new Map<string, JudgedResource>();
  for (const resource of resources) {
    const candidate = { resource, decision: proveOwnership(resource, context) };
    const key = resourceKey(resource);
    const kept = judged.get(key);
    if (kept === undefined || evidenceRank(candidate.decision) < evidenceRank(kept.decision)) {
      judged.set(key, candidate);
    }
  }
  return judged;
}

function evidenceRank(decision: OwnershipDecision): number {
  switch (decision.kind) {
    case 'excluded_baseline':
      return 0;
    case 'owned':
      return isDirectlyDeletable(decision.basis) ? 1 : 2;
    case 'ambiguous':
      return 3;
  }
}
