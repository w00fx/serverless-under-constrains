// Admission step A6 (SAFETY; design §10.1, BR-RUA-053, RK-08): the local toolchain and the
// account capabilities an execution needs before anything is deployed.
// - Node `>=24.12 <25` (native type stripping and the pinned engines range);
// - a locally installed esbuild 0.x (the bundler the scope snapshot resolves with);
// - `npm ls --all --json --package-lock-only` consistent with the lockfile;
// - the `CDKToolkit` bootstrap stack present in a usable state;
// - `lambda:GetAccountSettings` `UnreservedConcurrentExecutions` read and recorded, and at least
//   the number of functions the execution deploys, because every function needs one concurrent
//   environment and a throttled provider or consumer would change the transport under test.
// A read that fails is a safety rejection: an unknown capability is never assumed present.

import { boundedText } from '../record-contract/json-value.ts';
import { NONEMPTY_TRIMMED_PATTERN, err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { ToolVersions } from '../record-contract/records/group-a/source_provenance.ts';
import type { PortFailure, ToolchainFacts } from './admission-ports.ts';
import { admissionReason, portFailureReason } from './admission-reason.ts';
import { verdictOf } from './preflight-check.ts';
import type { CheckStatement, StepVerdict } from './preflight-check.ts';

const SUBJECT = 'BR-RUA-053';
const NODE_VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
const NODE_MAJOR = 24;
const NODE_MINIMUM_MINOR = 12;
const ESBUILD_VERSION_PATTERN = /^0\.\d+\.\d+$/;
/** CloudFormation states in which the bootstrap stack's resources exist and are usable. */
export const USABLE_BOOTSTRAP_STATUSES: readonly string[] = [
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
  'IMPORT_COMPLETE',
  'IMPORT_ROLLBACK_COMPLETE',
];

/** What the three capability reads answered. */
export interface CapabilityReadings {
  readonly toolchain: Result<ToolchainFacts, PortFailure>;
  readonly unreserved_concurrency: Result<number, PortFailure>;
  readonly bootstrap_status: Result<string | undefined, PortFailure>;
  /** The functions the execution deploys (the resource plan's count). */
  readonly required_concurrency: number;
}

/** The recorded capabilities of an admitted execution. */
export interface AdmittedCapabilities {
  readonly tool_versions: ToolVersions;
  readonly unreserved_concurrency: number;
}

/**
 * Step A6 over the capability readings.
 *
 * @example
 * const verdict = assessCapabilities(readings);
 * if (verdict.passed) verdict.value.tool_versions.node; // 'v24.15.0'
 */
export function assessCapabilities(readings: CapabilityReadings): StepVerdict<AdmittedCapabilities> {
  const toolchain = toolchainFacts(readings.toolchain);
  const concurrency = concurrencyReading(readings.unreserved_concurrency, readings.required_concurrency);
  const reasons = [
    ...(toolchain.ok ? [] : [toolchain.error]),
    ...(concurrency.ok ? [] : [concurrency.error]),
    ...bootstrapReasons(readings.bootstrap_status),
  ];
  const facts = toolchain.ok ? toolchain.value : undefined;
  const statement: CheckStatement = {
    subject: 'capabilities',
    expected: {
      node: '>=24.12 <25',
      esbuild: '0.x',
      dependency_tree: 'consistent',
      bootstrap_stack: 'CDKToolkit',
      unreserved_concurrency_minimum: readings.required_concurrency,
    },
    observed: {
      node: facts?.node_version ?? 'unread',
      esbuild: facts?.esbuild_version ?? 'absent',
      unreserved_concurrency: concurrency.ok ? concurrency.value : -1,
    },
  };
  return verdictOf('SAFETY', statement, [...reasons, ...(facts === undefined ? [] : toolReasons(facts))], {
    tool_versions: facts === undefined ? {} : toolVersionsOf(facts),
    unreserved_concurrency: concurrency.ok ? concurrency.value : 0,
  });
}

/**
 * Whether a Node version satisfies `>=24.12 <25`.
 *
 * @example
 * supportedNodeVersion('v24.15.0'); // true
 * supportedNodeVersion('v24.11.1'); // false
 */
export function supportedNodeVersion(version: string): boolean {
  const match = NODE_VERSION_PATTERN.exec(version);
  return match !== null && Number(match[1]) === NODE_MAJOR && Number(match[2]) >= NODE_MINIMUM_MINOR;
}

function toolchainFacts(reading: Result<ToolchainFacts, PortFailure>): Result<ToolchainFacts, StructuredReason> {
  return reading.ok
    ? reading
    : err(portFailureReason('TOOLCHAIN_UNREADABLE', SUBJECT, 'the toolchain read', reading.error));
}

function toolReasons(facts: ToolchainFacts): readonly StructuredReason[] {
  const reasons: StructuredReason[] = [];
  if (!supportedNodeVersion(facts.node_version)) {
    reasons.push(
      admissionReason(
        'NODE_VERSION_UNSUPPORTED',
        SUBJECT,
        `Node is ${boundedText(facts.node_version)}; expected >=24.12 <25`,
      ),
    );
  }
  if (facts.esbuild_version === undefined || !ESBUILD_VERSION_PATTERN.test(facts.esbuild_version)) {
    reasons.push(
      admissionReason(
        'ESBUILD_UNAVAILABLE',
        SUBJECT,
        `local esbuild is ${facts.esbuild_version === undefined ? 'absent' : boundedText(facts.esbuild_version)}; expected an installed 0.x version`,
      ),
    );
  }
  if (!facts.dependency_tree_consistent) {
    reasons.push(
      admissionReason(
        'DEPENDENCY_TREE_INCONSISTENT',
        SUBJECT,
        `npm ls reported ${boundedText(facts.dependency_tree_detail)}; expected a dependency tree consistent with the lockfile`,
      ),
    );
  }
  return reasons;
}

function concurrencyReading(reading: Result<number, PortFailure>, required: number): Result<number, StructuredReason> {
  if (!reading.ok) {
    return err(portFailureReason('ACCOUNT_SETTINGS_UNREADABLE', SUBJECT, 'lambda:GetAccountSettings', reading.error));
  }
  if (!Number.isSafeInteger(reading.value) || reading.value < required) {
    return err(
      admissionReason(
        'UNRESERVED_CONCURRENCY_LOW',
        SUBJECT,
        `UnreservedConcurrentExecutions is ${String(reading.value)}; expected an integer of at least ${String(required)}, one per deployed function`,
      ),
    );
  }
  return ok(reading.value);
}

function bootstrapReasons(reading: Result<string | undefined, PortFailure>): readonly StructuredReason[] {
  if (!reading.ok) {
    return [portFailureReason('BOOTSTRAP_UNREADABLE', SUBJECT, 'DescribeStacks CDKToolkit', reading.error)];
  }
  if (reading.value !== undefined && USABLE_BOOTSTRAP_STATUSES.includes(reading.value)) {
    return [];
  }
  return [
    admissionReason(
      'BOOTSTRAP_MISSING',
      SUBJECT,
      `the CDKToolkit stack is ${reading.value === undefined ? 'absent' : boundedText(reading.value)}; expected one of ${USABLE_BOOTSTRAP_STATUSES.join(', ')}`,
    ),
  ];
}

// Only versions that are nonempty trimmed strings are recorded (`tool_versions` values are).
function toolVersionsOf(facts: ToolchainFacts): ToolVersions {
  const versions: readonly (readonly [string, string | undefined])[] = [
    ['node', facts.node_version],
    ['npm', facts.npm_version],
    ['esbuild', facts.esbuild_version],
    ['aws_cdk_cli', facts.aws_cdk_cli_version],
  ];
  return Object.fromEntries(
    versions.filter((entry): entry is readonly [string, string] => isRecordableVersion(entry[1])),
  );
}

function isRecordableVersion(version: string | undefined): boolean {
  return version !== undefined && NONEMPTY_TRIMMED_PATTERN.test(version);
}
