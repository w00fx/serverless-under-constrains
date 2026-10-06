// The two ports of the deployment assembly (design §5.3 `deployment-assembly/`, §9.8; BR-RUA-042,
// D-25). Admission synthesizes once through `AssemblySynthesizer` (its read-only port set may hold
// it: synthesis writes only into the attempt's staging directory). Provisioning deploys through
// `AssemblyDeployer`, which accepts nothing but a `VerifiedDeployCopy`: that type is branded, and
// only `prepareVerifiedDeployCopy` creates one, after proving the copy byte-identical to the frozen
// inventory, so an unverified directory never reaches `cdk deploy`. Type-only (A-10).

import type { ExecutionSynthContext } from '../../infra/ownership/execution-context.ts';
import type { Result, Sha256Hex, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { KeyValueEntry } from '../record-contract/records/group-a/resource_manifest.ts';

/** What one synthesis produced in the staging directory (design §9.8 S1). */
export interface SynthReport {
  /** Absolute path of the synthesized cloud assembly: `<staging>/cdk.out`. */
  readonly assembly_dir: string;
  /** `SucRua-<kind>-<p>` of the synthesized execution. */
  readonly stack_name: string;
  /** The stack template, relative to `assembly_dir`: `<stack_name>.template.json`. */
  readonly template_file: string;
  /** Absolute path of the `execution-context.json` the synthesis read. */
  readonly context_file: string;
}

/**
 * Synthesizes the execution assembly exactly once into a staging directory.
 */
export interface AssemblySynthesizer {
  synthesize(context: ExecutionSynthContext, stagingDir: string): Promise<Result<SynthReport, StructuredReason>>;
}

/**
 * A temporary copy of the frozen assembly proven byte-identical to its inventory (D-25). Only
 * `prepareVerifiedDeployCopy` creates one; the brand keeps any other directory out of a deploy.
 */
export type VerifiedDeployCopy = {
  /** Absolute path of the copy, outside the evidence package. */
  readonly dir: string;
  /** The frozen inventory digest the copy was proven equal to. */
  readonly inventory_sha256: Sha256Hex;
} & { readonly __brand: 'VerifiedDeployCopy' };

/** The outcome of one `cdk deploy` of a verified copy (design §9.8 D2). */
export interface DeployReport {
  readonly stack_name: string;
  /** True only when the CLI exited 0 and its outputs file was read for this stack. */
  readonly deployed: boolean;
  readonly started_at: UtcMillis;
  readonly completed_at: UtcMillis;
  /** The stack outputs, sorted by key; empty when the deployment failed. */
  readonly outputs: readonly KeyValueEntry[];
  /** Why `deployed` is false; empty when it is true. */
  readonly reasons: readonly StructuredReason[];
}

/**
 * Deploys a verified copy of the frozen assembly. Stopping durable executions and deleting the
 * stack are cleanup steps behind the cleanup ports (design §10.4, WP-19), not deployment.
 */
export interface AssemblyDeployer {
  deploy(copy: VerifiedDeployCopy, stackName: string, outputsFile: string): Promise<DeployReport>;
}
