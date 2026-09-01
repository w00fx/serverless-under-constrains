import {
  COORDINATION_DESTROY_CONFIRMATION,
  COORDINATION_STACK_ID,
} from "./identity.ts";
import { classifyLeaseForDestroy } from "./leases.ts";
import type {
  CoordinationCloud,
  CoordinationCommandRequest,
  CoordinationCommandResult,
  CoordinationRejection,
} from "./types.ts";
import {
  gateOperatorCommand,
  observeDeployedBaseline,
  reject,
  unverifiedCoordination,
} from "./verify.ts";

const DESTROY_LEASE_CODES = {
  active: "coordination_lease_active",
  non_stale: "coordination_lease_non_stale",
  recovery_required: "coordination_lease_recovery_required",
  unverified: "coordination_state_unverified",
} as const;

export async function destroyCoordination(
  request: CoordinationCommandRequest,
  cloud: CoordinationCloud,
  now: () => Date = () => new Date(),
): Promise<CoordinationCommandResult> {
  const extraReasons: CoordinationRejection[] = [];
  if (request.confirmation !== COORDINATION_DESTROY_CONFIRMATION) {
    extraReasons.push({
      code: "destroy_confirmation_invalid",
      category: "configuration",
      expected: COORDINATION_DESTROY_CONFIRMATION,
      observed: request.confirmation,
    });
  }

  const gate = await gateOperatorCommand(request, cloud, extraReasons);
  if (!gate.ok) {
    return gate.result;
  }

  let leases;
  try {
    leases = await cloud.listLeases();
  } catch (error) {
    return unverifiedCoordination(
      "readable lease items",
      error instanceof Error ? error.message : "lease scan failed",
    );
  }

  const checkedAt = now();
  const leaseReasons: CoordinationRejection[] = [];
  for (const item of leases) {
    const verdict = classifyLeaseForDestroy(item, checkedAt);
    if (verdict === "allow") {
      continue;
    }
    leaseReasons.push({
      code: DESTROY_LEASE_CODES[verdict],
      category: "coordination",
      expected: "no active, non-stale, or recovery-required leases",
      observed: item,
    });
  }

  if (leaseReasons.length > 0) {
    return reject(leaseReasons);
  }

  await cloud.destroyStack(COORDINATION_STACK_ID);
  return confirmDestroyed(cloud);
}

async function confirmDestroyed(
  cloud: CoordinationCloud,
): Promise<CoordinationCommandResult> {
  const observed = await observeDeployedBaseline(cloud);
  if (!observed.ok) {
    return observed.result;
  }
  if (observed.stack !== undefined || observed.table !== undefined) {
    return unverifiedCoordination("absent stack and table", {
      stack: observed.stack,
      table: observed.table,
    });
  }
  return { status: "destroyed" };
}
