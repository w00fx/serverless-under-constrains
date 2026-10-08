// Property tests of the operator CLI's untrusted-input boundaries (testing rule 6; A-05
// totality): the argument vector, the package operand and the `--rev` revision. Over any tokens
// (flag-like text, inherited member names, empty and huge tokens included) parsing answers without
// throwing, a parse never invents a flag or operand the grammar lacks, `main` always prints exactly
// one schema-valid `cli_result` line whose exit code its outcome has, a located package is exactly
// `<root>/<kind-dir>/<uuid4>`, and every refusal detail stays bounded.
// Runs FC_RUNS cases per property (10,000 under `npm run test:fuzz`).

import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { parseArgs } from '../../../src/operator-cli/arg-parsing.ts';
import { main } from '../../../src/operator-cli/cli-main.ts';
import { exitCodeOf } from '../../../src/operator-cli/cli-result.ts';
import { OracleRevisionCheckCommand } from '../../../src/operator-cli/oracle-revision-check.ts';
import { locatePackage } from '../../../src/operator-cli/package-location.ts';
import { executionIdOf } from '../../../src/evidence-package/package-layout.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { CliResult } from '../../../src/record-contract/records/group-c/cli_result.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { FakeGoldenSuiteRunner } from '../../support/admission/fake-golden-suite-runner.ts';
import { MemoryPackageFileSystem } from '../../support/evidence-package/memory-package-file-system.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { INHERITED_MEMBER_NAMES } from '../../support/record-contract/json-paths.ts';
import { ScriptedRevisionWorkspace } from '../../integration/operator-cli/fakes/scripted-revision-workspace.ts';
import { harnessRoot } from '../../unit/operator-cli/support/cli-harness.ts';
import { RecordingCliCommand } from '../../unit/operator-cli/support/recording-cli-command.ts';

const MAX_DETAIL = 2_000;
const ROOT = '/operator/evidence';
const validator = createRecordValidator();
const WORDS = ['probe', 'verify', 'run', 'recover', 'oracle', 'evaluate', 'revision-check'];
const FLAGS = ['--head', '--rev', '--package', '--evidence-root', '--confirm-cloud-mutation', '--', '---', '--HEAD'];

function commands(): RecordingCliCommand[] {
  return [
    new RecordingCliCommand(['probe', 'verify'], ['package'], { head: 'optional' }),
    new RecordingCliCommand(['recover'], ['package'], { 'confirm-cloud-mutation': 'required' }),
    new RecordingCliCommand(['oracle'], ['trial-dir']),
    new RecordingCliCommand(['oracle', 'evaluate'], ['trial-dir']),
  ];
}

const token: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...WORDS, ...FLAGS, '', 'evidence/runs/x'),
  fc.constantFrom(...INHERITED_MEMBER_NAMES).map((name) => `--${name}`),
  fc.constantFrom(...INHERITED_MEMBER_NAMES),
  fc.string({ maxLength: 12 }),
  fc.string({ minLength: 600, maxLength: 900 }),
);
const argv: fc.Arbitrary<string[]> = fc.oneof(
  fc.array(token, { maxLength: 8 }),
  fc
    .tuple(fc.constantFrom(['probe', 'verify'], ['recover'], ['oracle', 'evaluate']), fc.array(token, { maxLength: 6 }))
    .map(([words, rest]) => [...words, ...rest]),
);

describe('operator input totality', () => {
  it('parseArgs answers without throwing and never invents a flag or operand', () => {
    const known = commands();
    fc.assert(
      fc.property(argv, (tokens) => {
        const parsed = parseArgs(tokens, known);
        if (!parsed.ok) {
          assert.equal(parsed.error.code, 'USAGE_ERROR');
          assert.ok(parsed.error.detail.length <= MAX_DETAIL);
          return;
        }
        const spec = known.find((command) => command.spec.words.join(' ') === parsed.value.command)?.spec;
        assert.ok(spec !== undefined);
        assert.deepEqual([...parsed.value.positionals.keys()], [...spec.positionals]);
        assert.ok([...parsed.value.positionals.values()].every((value) => value.length > 0 && tokens.includes(value)));
        assert.ok([...parsed.value.flags.keys()].every((name) => spec.flags.has(name)));
        assert.ok(parsed.value.evidence_root.length > 0);
      }),
      fuzzParameters(),
    );
  });

  it('main prints exactly one valid cli_result line with the exit code of its outcome', async () => {
    await fc.assert(
      fc.asyncProperty(argv, async (tokens) => {
        const stdout: string[] = [];
        const exitCode = await main(
          tokens,
          { stdout: (line) => stdout.push(line), stderr: () => undefined },
          harnessRoot(commands()),
        );
        assert.equal(stdout.length, 1);
        const result = JSON.parse(stdout[0] ?? '') as CliResult;
        assert.equal(validator.validateAs('cli_result', result as unknown as JsonValue).valid, true);
        assert.equal(exitCode, exitCodeOf(result.outcome));
        assert.ok(result.outcome === 'completed' || result.outcome === 'usage_error');
      }),
      fuzzParameters(),
    );
  });

  it('locatePackage answers without throwing and accepts exactly <root>/<kind-dir>/<uuid4>', () => {
    const segment = fc.oneof(
      fc.constantFrom('runs', 'transport-probes', 'variant-validations', '..', '.', '', 'constructor', '__proto__'),
      fc.uuid({ version: 4 }),
      fc.uuid(),
      fc.string({ maxLength: 10 }),
    );
    fc.assert(
      fc.property(fc.boolean(), fc.array(segment, { maxLength: 4 }), (inside, segments) => {
        const path = inside ? join(ROOT, ...segments) : resolve('/', ...segments);
        const located = locatePackage(ROOT, path);
        if (!located.ok) {
          assert.equal(located.error.code, 'USAGE_ERROR');
          assert.ok(located.error.detail.length <= MAX_DETAIL);
          return;
        }
        const kindDirectory = {
          RUN: 'runs',
          TRANSPORT_PROBE: 'transport-probes',
          VARIANT_VALIDATION: 'variant-validations',
        }[located.value.execution_kind];
        assert.equal(resolve(path), join(ROOT, kindDirectory, executionIdOf(located.value)));
        assert.match(
          executionIdOf(located.value),
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      }),
      fuzzParameters(),
    );
  });

  it('a --rev value reaches git only as a revision name', async () => {
    const golden = await new FakeGoldenSuiteRunner().readGoldenSuiteRun();
    assert.equal(golden.ok, true);
    const revision = fc.oneof(
      fc.string({ maxLength: 20 }),
      fc.constantFrom('-x', '--upload-pack=x', 'HEAD', 'main~1', 'v1.0^{}', 'a b', `a${'b'.repeat(300)}`),
      fc.constantFrom(...INHERITED_MEMBER_NAMES),
    );
    await fc.assert(
      fc.asyncProperty(revision, async (rev) => {
        const workspace = new ScriptedRevisionWorkspace(new Map(), golden.value);
        const command = new OracleRevisionCheckCommand({
          workspace,
          files: (): MemoryPackageFileSystem => new MemoryPackageFileSystem(),
          validator,
          clock: harnessRoot([]).clock,
          node_version: 'v24.15.0',
        });
        const parsed = parseArgs(['oracle', 'revision-check', '--rev', rev], [command]);
        if (!parsed.ok) {
          return;
        }
        const report = await command.run(parsed.value, {
          evidence_root: ROOT,
          resolvePath: (path) => resolve('/operator', path),
          progress: () => undefined,
        });
        const reached = /^[0-9A-Za-z][0-9A-Za-z._/@{}^~-]{0,255}$/.test(rev);
        assert.deepEqual(workspace.calls, reached ? [`checkout ${rev}`] : []);
        assert.equal(report.outcome, reached ? 'verification_failed' : 'usage_error');
        assert.ok(report.reasons.every((reason) => reason.detail.length <= MAX_DETAIL));
      }),
      fuzzParameters(),
    );
  });

  it('parses a 100,000-token argument vector without throwing', () => {
    const tokens = ['probe', 'verify', ...Array.from({ length: 100_000 }, (_, index) => `operand-${String(index)}`)];
    const parsed = parseArgs(tokens, commands());
    assert.equal(parsed.ok, false);
    assert.ok(parsed.error.detail.length <= MAX_DETAIL);
  });
});
