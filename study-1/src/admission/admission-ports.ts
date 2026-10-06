// The request, the ports and the outcome of read-only admission (design §5.3 `admission/`, §10.1;
// BR-RUA-039..042, -017, -028, -046, -055). Every port method is a read, except three local
// writes that never reach the cloud (design §10.1): `synthesize` writes only into the attempt's
// staging directory, `append` only the attempt's preflight journal under
// `evidence/admission-attempts/`, and `createFile` only evidence files (the rejection record, or
// the admitted package's `admission/` directory). `ADMISSION_LOCAL_WRITE_METHODS` names them, and
// a unit test asserts that every other port method name starts with a read verb.
// Type-only, except that one constant list (A-10).

import type { AssemblyFileSystem } from '../deployment-assembly/assembly-file-system.ts';
import type { AssemblySynthesizer } from '../deployment-assembly/assembly-ports.ts';
import type { AppendOnlyFile } from '../event-journal/append-only-file.ts';
import type { LeaseStorePort } from '../coordination-lease/lease-store-port.ts';
import type {
  ExecutionIdentity,
  ExecutionKind,
  JsonValue,
  Result,
  Sha256Hex,
  StructuredReason,
  UuidSource,
  Uuid4,
  VariantId,
  WallClock,
} from '../record-contract/primitives.ts';
import type { RecordType } from '../record-contract/record-types.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { ScopeRecomputationPorts } from '../transport-qualification/scope/scope-recomputation.ts';
import type { ProbePackageInput } from '../transport-qualification/verdict/probe-usability-reader.ts';

/** The probe a run or a variant validation explicitly selects (BR-RUA-028, CLI `--probe`). */
export interface QualificationSelection {
  readonly transport_probe_id: Uuid4;
  readonly original_package_index_sha256: Sha256Hex;
  /** The explicitly selected amendment head, or `null` for the original package alone. */
  readonly amendment_head_sha256: Sha256Hex | null;
}

/** The two financial input records of every trial (CTR-RUA-005, CTR-RUA-006), as parsed JSON. */
export interface FinancialInputRecords {
  readonly payment: JsonValue;
  readonly approved_decision: JsonValue;
}

export interface AdmissionRequest {
  readonly kind: ExecutionKind;
  /** Absolute path of the operator's environment input file (BR-RUA-041). */
  readonly environment_input_path: string;
  /** The single variant of a variant validation; absent otherwise. */
  readonly variant?: VariantId;
  /** The selected probe of a run or a variant validation; absent for a probe. */
  readonly qualification?: QualificationSelection;
  readonly financial_inputs: FinancialInputRecords;
}

/** Why a read port could not answer; `detail` names what was read and the expected state. */
export interface PortFailure {
  readonly code: string;
  readonly detail: string;
}

export type PortResult<T> = Promise<Result<T, PortFailure>>;

/** An operation git can leave unfinished in the work tree (BR-RUA-042). */
export type InProgressOperation = 'MERGE' | 'REBASE' | 'CHERRY_PICK';

/** What git says about the work tree that contains `study-1/` (design D-01). */
export interface GitSourceState {
  /** `git status --porcelain=v2 --branch -z --untracked-files=all --ignore-submodules=none` output. */
  readonly status_porcelain_v2: string;
  /** `git rev-parse HEAD^{tree}`; absent when HEAD does not resolve. */
  readonly tree_sha?: string;
  readonly in_progress: readonly InProgressOperation[];
  /** The package lockfile, at its path relative to the repository root. */
  readonly lockfile: { readonly path: string; readonly tracked: boolean; readonly bytes?: Uint8Array };
}

export interface GitProvenancePort {
  readGitSourceState(): PortResult<GitSourceState>;
}

/** Local tool versions and the lockfile consistency check (design §10.1 A6). */
export interface ToolchainFacts {
  /** `process.version`, for example `v24.15.0`. */
  readonly node_version: string;
  readonly npm_version?: string;
  /** The locally installed esbuild; absent when none is installed. */
  readonly esbuild_version?: string;
  readonly aws_cdk_cli_version?: string;
  /** `npm ls --all --json --package-lock-only` exited 0 with no problem. */
  readonly dependency_tree_consistent: boolean;
  readonly dependency_tree_detail: string;
}

export interface ToolchainReadPort {
  readToolchain(): PortResult<ToolchainFacts>;
}

/** `sts:GetCallerIdentity` and the Region the clients are configured for. */
export interface CallerIdentity {
  readonly account: string;
  readonly arn: string;
  readonly region: string;
}

export interface CallerIdentityPort {
  readCallerIdentity(): PortResult<CallerIdentity>;
}

export interface AccountSettingsReadPort {
  /** `lambda:GetAccountSettings` `AccountLimit.UnreservedConcurrentExecutions` (RK-08). */
  readUnreservedConcurrency(): PortResult<number>;
}

export interface BootstrapStackReadPort {
  /** `DescribeStacks CDKToolkit`: its status, or `undefined` when the stack does not exist. */
  readBootstrapStackStatus(): PortResult<string | undefined>;
}

export interface CoordinationKeyAttribute {
  readonly attribute_name: string;
  readonly key_type: string;
  /** The attribute's scalar type from the definitions, absent when not defined. */
  readonly attribute_type?: string;
}

/** `DescribeTable` and `DescribeTimeToLive` of the coordination table (design §9.1). */
export interface CoordinationTableDescription {
  readonly table_arn: string;
  readonly table_status: string;
  readonly key_schema: readonly CoordinationKeyAttribute[];
  readonly deletion_protection_enabled: boolean;
  /** `TimeToLiveStatus`: `DISABLED` is the only acceptable value. */
  readonly time_to_live_status: string;
}

export interface CoordinationTableReadPort {
  readCoordinationTable(tableArn: string): PortResult<CoordinationTableDescription>;
}

/** The coordination lease item, read strongly consistently (BR-RUA-045). */
export type LeaseReadPort = Pick<LeaseStorePort, 'read'>;

export interface ProbePackageReadPort {
  /** The selected probe's package, every amendment found for it and the selection. */
  readProbePackage(selection: QualificationSelection): PortResult<ProbePackageInput>;
}

/** One golden case's declared verdict-changing pairs (design §12.4 `rule_outcomes_reached`). */
export interface GoldenCaseDeclaration {
  readonly case_id: string;
  readonly rule_outcomes: readonly { readonly rule_id: string; readonly outcome: string }[];
}

/** One `npm run test:golden -- --report-json` run at the admitted HEAD (design §10.1 A9). */
export interface GoldenSuiteRun {
  readonly command: string;
  readonly exit_code: number;
  /** The exact `--report-json` bytes `tools/run-suite.ts` wrote. */
  readonly report_bytes: Uint8Array;
  /** Every trial-oracle golden case's declaration, as committed. */
  readonly case_declarations: readonly GoldenCaseDeclaration[];
}

export interface GoldenSuiteReadPort {
  readGoldenSuiteRun(): PortResult<GoldenSuiteRun>;
}

/** One catalogue schema file, copied byte for byte into the package (`admission/schemas/`). */
export interface SchemaCopy {
  readonly record_type: RecordType;
  /** POSIX path relative to the schema root, for example `group-a/payment.schema.json`. */
  readonly relative_path: string;
  readonly bytes: Uint8Array;
}

export interface SchemaCatalogReadPort {
  /** Every record schema of the committed catalogue. */
  readSchemaCatalog(): PortResult<readonly SchemaCopy[]>;
}

/** Absolute local directories admission works in. */
export interface AdmissionPaths {
  /** The evidence root (`study-1/evidence`); package and attempt paths are relative to it. */
  readonly evidence_root: string;
  /** The parent of every attempt's synthesis staging directory, outside the evidence root. */
  readonly staging_root: string;
}

export interface AdmissionPorts {
  readonly git: GitProvenancePort;
  readonly toolchain: ToolchainReadPort;
  readonly sts: CallerIdentityPort;
  readonly lambdaAccount: AccountSettingsReadPort;
  readonly bootstrap: BootstrapStackReadPort;
  readonly coordination: CoordinationTableReadPort;
  readonly lease: LeaseReadPort;
  readonly packages: ProbePackageReadPort;
  readonly goldenSuite: GoldenSuiteReadPort;
  readonly schemas: SchemaCatalogReadPort;
  readonly synthesizer: AssemblySynthesizer;
  readonly scope: ScopeRecomputationPorts;
  readonly files: AssemblyFileSystem;
  readonly journal: AppendOnlyFile;
  readonly clock: WallClock;
  readonly ids: UuidSource;
  readonly validator: RecordValidator;
  readonly paths: AdmissionPaths;
}

/** The port methods that write locally; every other method of `AdmissionPorts` reads. */
export const ADMISSION_LOCAL_WRITE_METHODS = ['synthesize', 'append', 'createFile', 'finalize'] as const;

export type AdmissionOutcome =
  | {
      readonly kind: 'admitted';
      readonly admission_attempt_id: Uuid4;
      /** Package-relative to the evidence root, for example `runs/<id>/admission/execution-manifest.json`. */
      readonly manifest_path: string;
      readonly manifest_sha256: Sha256Hex;
      readonly execution: ExecutionIdentity;
    }
  | {
      readonly kind: 'rejected';
      readonly admission_attempt_id: Uuid4;
      readonly rejection_path: string;
      readonly reasons: readonly StructuredReason[];
    }
  | {
      /** The attempt's own evidence could not be written; nothing was admitted (CLI exit 10). */
      readonly kind: 'failed';
      readonly admission_attempt_id: Uuid4;
      readonly reasons: readonly StructuredReason[];
    };
