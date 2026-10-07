// The real-cloud e2e drivers' operator (design §11, §12.1 e2e row, §14 rows 002, 021, 027): it
// runs the operator CLI as the operator does, `node src/operator-cli/main.ts <command>` from the
// study root, as a child process with the operator's environment, and reads the package it
// writes. NOT OFFLINE: only `npm run test:e2e` loads it, and that refuses to start unless
// `RUA_E2E_ENV=<environment-input file>` and `RUA_E2E_CONFIRM=<execution_id>` are set.
//
// Confirmation (decisions WP-28): `RUA_E2E_CONFIRM` names the one admitted execution the driver
// may mutate the cloud for; it is passed as `--confirm-cloud-mutation`, which the CLI requires to
// equal the admitted id. Admission is the operator's read-only step before the driver
// (`rua probe admit --env "$RUA_E2E_ENV"`, then `rua run admit … --probe <the passing probe>`),
// so each driver file runs on its own: `node tools/run-suite.ts e2e test/e2e/<file>`.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import { isUuid4 } from '../../../src/record-contract/identifiers.ts';
import { isJsonObject } from '../../../src/record-contract/json-value.ts';
import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import type { ExecutionIdentity, JsonObject, JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { RecordType } from '../../../src/record-contract/record-types.ts';
import type { CliResult } from '../../../src/record-contract/records/group-c/cli_result.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';

/** The study root every command runs from. */
export const STUDY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** The default evidence root of the CLI (design §11). */
export const E2E_EVIDENCE_ROOT = join(STUDY_ROOT, 'evidence');

const validator = createRecordValidator();
// A real run waits for every trial, the closure and cleanup; no command may hang the driver forever.
const COMMAND_TIMEOUT_MS = 3 * 60 * 60 * 1000;

export interface E2eSettings {
  /** The operator's environment input file. */
  readonly environment_input: string;
  /** The admitted execution the driver may mutate the cloud for. */
  readonly confirmed_id: Uuid4;
}

/** One CLI invocation as the operator sees it. */
export interface OperatorRun {
  readonly argv: readonly string[];
  readonly exit_code: number | null;
  readonly result: CliResult;
  readonly stderr: string;
}

/**
 * The e2e environment, refused with the expected shape when it is incomplete.
 *
 * @example
 * const { confirmed_id } = e2eSettings(process.env);
 */
export function e2eSettings(env: Readonly<Record<string, string | undefined>>): E2eSettings {
  const environmentInput = env['RUA_E2E_ENV'] ?? '';
  const confirmedId = env['RUA_E2E_CONFIRM'] ?? '';
  if (environmentInput === '' || !isUuid4(confirmedId)) {
    throw new Error(
      `RUA_E2E_ENV=${JSON.stringify(environmentInput)} RUA_E2E_CONFIRM=${JSON.stringify(confirmedId)}; expected an environment-input file and the admitted execution_id (lowercase UUIDv4)`,
    );
  }
  return { environment_input: resolve(environmentInput), confirmed_id: confirmedId };
}

/**
 * The admitted package of the confirmed execution; its frozen manifest must already exist.
 *
 * @example
 * admittedPackage({ execution_kind: 'TRANSPORT_PROBE', transport_probe_id: id }); // '<study>/evidence/transport-probes/<id>'
 */
export function admittedPackage(identity: ExecutionIdentity): string {
  const directory = join(E2E_EVIDENCE_ROOT, PACKAGE_LAYOUT.executionDirectory(identity));
  const manifest = join(directory, EXECUTION_PATHS.executionManifest);
  assert.ok(
    existsSync(manifest),
    `${manifest} is absent; expected the operator to have admitted ${identity.execution_kind} before the driver`,
  );
  return directory;
}

/**
 * Runs one operator command from the study root and parses its single `cli_result` line.
 *
 * @example
 * const verify = await runOperator(['probe', 'verify', packageDir]);
 * verify.exit_code; // 0 when the probe is usable
 */
export function runOperator(argv: readonly string[]): Promise<OperatorRun> {
  const command = [join(STUDY_ROOT, 'src', 'operator-cli', 'main.ts'), ...argv, '--evidence-root', E2E_EVIDENCE_ROOT];
  // `node --test` marks its children; the CLI's own child runners must not report to it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT'));
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, command, { cwd: STUDY_ROOT, env, timeout: COMMAND_TIMEOUT_MS });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      process.stderr.write(chunk);
    });
    child.on('error', rejectRun);
    child.on('close', (code: number | null) => {
      const lines = Buffer.concat(stdout)
        .toString('utf8')
        .split('\n')
        .filter((line) => line !== '');
      if (lines.length !== 1) {
        rejectRun(
          new Error(`rua ${argv.join(' ')} printed ${String(lines.length)} stdout lines; expected one cli_result`),
        );
        return;
      }
      resolveRun({
        argv,
        exit_code: code,
        result: JSON.parse(lines[0] ?? '') as CliResult,
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

/**
 * One record of the package, parsed and validated against its schema.
 *
 * @example
 * const result = packageRecord(packageDir, 'probe/derived/transport-probe-result.json', 'transport_probe_result');
 */
export function packageRecord(packageDirectory: string, relativePath: string, recordType: RecordType): JsonObject {
  const path = join(packageDirectory, relativePath);
  const parsed = parseJsonDocument(readFileSync(path));
  assert.ok(parsed.ok && isJsonObject(parsed.value), `${path} is not a JSON object; expected one ${recordType}`);
  const validation = validator.validateAs(recordType, parsed.value);
  if (!validation.valid) {
    assert.fail(`${path} is not a valid ${recordType}: ${JSON.stringify(validation.violations)}`);
  }
  return parsed.value;
}

/**
 * Asserts an operator command answered exit 0, showing its reasons otherwise.
 *
 * @example
 * assertCompleted(await runOperator(['probe', 'verify', packageDir]));
 */
export function assertCompleted(run: OperatorRun): void {
  assert.equal(run.exit_code, 0, `rua ${run.argv.join(' ')}: ${JSON.stringify(run.result.reasons)}`);
  assert.equal(run.result.outcome, 'completed');
}

/**
 * Asserts an execute command completed for exactly `execution` and names its finalized package
 * index as the one written path (design §11: the `cli_result` of an execute command).
 *
 * @example
 * assertExecuted(execute, { execution_kind: 'RUN', run_id: runId });
 */
export function assertExecuted(run: OperatorRun, execution: ExecutionIdentity): void {
  assertCompleted(run);
  const named = run.result as unknown as Readonly<Record<string, unknown>>;
  // The result names the execution by its id member alone (`cli_result` carries no kind).
  for (const [field, value] of Object.entries(execution).filter(([name]) => name !== 'execution_kind')) {
    assert.equal(named[field], value, `cli_result ${field}`);
  }
  assert.deepEqual(run.result.written_paths, [
    `${PACKAGE_LAYOUT.executionDirectory(execution)}/${EXECUTION_PATHS.packageIndex}`,
  ]);
}

/**
 * The string member `name` of a record, asserted to be a string.
 *
 * @example
 * stringMember(manifest['qualification'], 'transport_probe_id'); // '0b6d…'
 */
export function stringMember(record: JsonValue | undefined, name: string): string {
  const value = isJsonObject(record) ? record[name] : undefined;
  assert.ok(typeof value === 'string', `${name} is ${JSON.stringify(value)}; expected a string member`);
  return value;
}
