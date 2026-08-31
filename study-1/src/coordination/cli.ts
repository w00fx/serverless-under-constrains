import { bootstrapCoordination } from "./bootstrap.ts";
import { destroyCoordination } from "./destroy.ts";
import { COORDINATION_DESTROY_CONFIRMATION } from "./identity.ts";
import { isExecutedAsMain } from "./main-module.ts";
import type {
  CoordinationCloud,
  CoordinationCommandRequest,
} from "./types.ts";
import { verifyCoordination } from "./verify.ts";

export const COORDINATION_COMMANDS = ["bootstrap", "verify", "destroy"] as const;
export type CoordinationCommandName = (typeof COORDINATION_COMMANDS)[number];

export function parseCoordinationCommand(
  argv: string[],
): CoordinationCommandName {
  const command = argv[0];
  if (command === "bootstrap" || command === "verify" || command === "destroy") {
    return command;
  }
  throw new Error(
    `unknown coordination command: ${String(command)}; expected ${COORDINATION_COMMANDS.join(", ")}`,
  );
}

export async function dispatchCoordinationCommand(
  command: CoordinationCommandName,
  request: CoordinationCommandRequest,
  cloud: CoordinationCloud,
  now?: () => Date,
) {
  switch (command) {
    case "bootstrap":
      return bootstrapCoordination(request, cloud);
    case "verify":
      return verifyCoordination(request, cloud);
    case "destroy":
      return destroyCoordination(request, cloud, now);
  }
}

if (isExecutedAsMain(import.meta.url)) {
  const command = parseCoordinationCommand(process.argv.slice(2));
  process.stderr.write(
    `coordination:${command} requires an injected cloud adapter; tests provide a fake and live AWS binding is operator-owned\n`,
  );
  if (command === "destroy") {
    process.stderr.write(
      `destroy also requires confirmation ${COORDINATION_DESTROY_CONFIRMATION}\n`,
    );
  }
  process.exitCode = 2;
}
