import {
  ALLOWED_REGION,
  COORDINATION_DESTROY_CONFIRMATION,
  COORDINATION_STACK_ID,
  COORDINATION_TABLE_NAME,
} from "./identity.ts";
import { classifyLeaseForDestroy } from "./leases.ts";
import type {
  CoordinationCloud,
  CoordinationCommandRequest,
  CoordinationCommandResult,
  CoordinationRejection,
} from "./types.ts";
import {
  collectDeployedIdentityReasons,
  collectRequestIdentityReasons,
  reject,
} from "./verify.ts";

export async function destroyCoordination(
  request: CoordinationCommandRequest,
  cloud: CoordinationCloud,
  now: () => Date = () => new Date(),
): Promise<CoordinationCommandResult> {
  const reasons: CoordinationRejection[] = [];
  if (request.confirmation !== COORDINATION_DESTROY_CONFIRMATION) {
    reasons.push({
      code: "destroy_confirmation_invalid",
      category: "configuration",
      expected: COORDINATION_DESTROY_CONFIRMATION,
      observed: request.confirmation,
    });
  }

  const callerAccountId = await cloud.getCallerAccountId();
  reasons.push(...collectRequestIdentityReasons(request, callerAccountId));
  if (reasons.length > 0) {
    return reject(reasons);
  }

  const stack = await cloud.describeStack(COORDINATION_STACK_ID);
  const table = await cloud.describeTable(COORDINATION_TABLE_NAME);
  reasons.push(
    ...collectDeployedIdentityReasons(callerAccountId, ALLOWED_REGION, stack, table),
  );
  if (reasons.length > 0) {
    return reject(reasons);
  }

  let leases;
  try {
    leases = await cloud.listLeases();
  } catch (error) {
    return reject([
      {
        code: "coordination_state_unverified",
        category: "coordination",
        expected: "readable lease items",
        observed: error instanceof Error ? error.message : "lease scan failed",
      },
    ]);
  }

  const checkedAt = now();
  for (const item of leases) {
    const verdict = classifyLeaseForDestroy(item, checkedAt);
    if (verdict === "allow") {
      continue;
    }
    reasons.push({
      code:
        verdict === "active"
          ? "coordination_lease_active"
          : verdict === "non_stale"
            ? "coordination_lease_non_stale"
            : verdict === "recovery_required"
              ? "coordination_lease_recovery_required"
              : "coordination_state_unverified",
      category: "coordination",
      expected: "no active, non-stale, or recovery-required leases",
      observed: item,
    });
  }

  if (reasons.length > 0) {
    return reject(reasons);
  }

  await cloud.destroyStack(COORDINATION_STACK_ID);
  return { status: "destroyed" };
}
