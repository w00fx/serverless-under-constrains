// Property tests of the command-level untrusted inputs (testing rule 6; A-05 totality): the probe
// selection and digest flags, the variant, the operator's financial input files, the trial
// directory of `oracle evaluate`, and the coordination table ARN of the environment input. Over
// any values each parser answers without throwing, accepts exactly its documented shape and
// quotes what it refuses within a bounded detail; an admit command reaches admission only with
// inputs that parse, carrying the parsed JSON unchanged.
// Runs FC_RUNS cases per property (10,000 under `npm run test:fuzz`).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { AdmissionOutcome } from '../../../src/admission/admission-ports.ts';
import { AdmitCommand, admitSpec } from '../../../src/operator-cli/admit-commands.ts';
import { coordinationTableName } from '../../../src/operator-cli/environment-lease-reader.ts';
import { locateTrial } from '../../../src/operator-cli/oracle-evaluate-command.ts';
import { parseDigestFlag } from '../../../src/operator-cli/package-reading.ts';
import { parseSelection } from '../../../src/operator-cli/run-completion-inputs.ts';
import { isUuid4 } from '../../../src/record-contract/identifiers.ts';
import type { Sha256Hex, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { runCli } from '../../unit/operator-cli/support/cli-harness.ts';
import { MemoryInputFileReader } from '../../unit/operator-cli/support/memory-input-file-reader.ts';
import { ScriptedExecutionAdmitter } from '../../unit/operator-cli/support/scripted-execution-admitter.ts';

const MAX_DETAIL = 2_000;
const DIGEST = /^[0-9a-f]{64}$/;
const ROOT = '/operator/evidence';
const PROBE_ID = '0000a001-0000-4000-8000-000000000003' as Uuid4;
const ADMITTED: AdmissionOutcome = {
  kind: 'admitted',
  admission_attempt_id: '0000a001-0000-4000-8000-000000000001' as Uuid4,
  manifest_path: `transport-probes/${PROBE_ID}/admission/execution-manifest.json`,
  manifest_sha256: 'c'.repeat(64) as Sha256Hex,
  execution: { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: PROBE_ID },
};

const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/);
const uuid = fc.uuid({ version: 4 });
const flagText = fc.oneof(
  hex64,
  uuid,
  fc.constantFrom('', 'conventional', 'durable', 'Durable', 'A'.repeat(64)),
  fc.string({ maxLength: 70 }),
  fc.string({ minLength: 600, maxLength: 900 }),
);
const optionalFlag = fc.option(flagText, { nil: undefined });

function flagMap(entries: readonly (readonly [string, string | undefined])[]): Map<string, string> {
  return new Map(entries.filter((entry): entry is [string, string] => entry[1] !== undefined));
}

describe('command input totality', () => {
  it('parseSelection accepts exactly a UUIDv4 probe and lowercase hex digests', () => {
    fc.assert(
      fc.property(optionalFlag, optionalFlag, optionalFlag, (probe, index, head) => {
        const parsed = parseSelection(
          flagMap([
            ['probe', probe],
            ['probe-index', index],
            ['probe-head', head],
          ]),
        );
        const valid = isUuid4(probe ?? '') && DIGEST.test(index ?? '') && (head === undefined || DIGEST.test(head));
        assert.equal(parsed.ok, valid);
        if (!parsed.ok) {
          assert.equal(parsed.error.code, 'USAGE_ERROR');
          assert.ok(parsed.error.detail.length <= MAX_DETAIL);
          return;
        }
        assert.deepEqual(parsed.value, {
          transport_probe_id: probe,
          original_package_index_sha256: index,
          amendment_head_sha256: head ?? null,
        });
      }),
      fuzzParameters(),
    );
  });

  it('parseDigestFlag accepts exactly 64 lowercase hexadecimal characters or an absent flag', () => {
    fc.assert(
      fc.property(optionalFlag, (value) => {
        const parsed = parseDigestFlag('head', value);
        assert.equal(parsed.ok, value === undefined || DIGEST.test(value));
        assert.ok(parsed.ok || parsed.error.detail.length <= MAX_DETAIL);
      }),
      fuzzParameters(),
    );
  });

  it('locateTrial names a trial exactly for <root>/{runs|variant-validations}/<uuid4>/trials/<uuid4>', () => {
    const segment = fc.oneof(uuid, fc.constantFrom('', '.', '..', 'trials', 'runs'), fc.string({ maxLength: 40 }));
    const directory = fc.oneof(
      fc
        .tuple(fc.constantFrom('runs', 'variant-validations', 'transport-probes', 'Runs'), segment, segment, segment)
        .map(([kind, id, trials, trial]) => ({
          path: `${ROOT}/${kind}/${id}/${trials}/${trial}`,
          parts: [kind, id, trials, trial],
        })),
      fc.string({ maxLength: 120 }).map((path) => ({ path, parts: [] as string[] })),
    );
    fc.assert(
      fc.property(directory, ({ path, parts }) => {
        const located = locateTrial(ROOT, path);
        const [kind = '', id = '', trials = '', trial = ''] = parts;
        const expected =
          (kind === 'runs' || kind === 'variant-validations') && isUuid4(id) && trials === 'trials' && isUuid4(trial);
        assert.equal(located.ok, expected, path);
        if (!located.ok) {
          assert.equal(located.error.code, 'USAGE_ERROR');
          assert.ok(located.error.detail.length <= MAX_DETAIL);
          return;
        }
        assert.equal(located.value.trial_id, trial);
      }),
      fuzzParameters(),
    );
  });

  it('coordinationTableName gives the name of exactly a DynamoDB table ARN', () => {
    const name = fc.stringMatching(/^[A-Za-z0-9_.-]{3,255}$/);
    const arn = fc.oneof(
      fc
        .tuple(fc.constantFrom('us-east-1', 'eu-west-2'), fc.stringMatching(/^\d{12}$/), name)
        .map(([region, account, table]) => `arn:aws:dynamodb:${region}:${account}:table/${table}`),
      fc.string({ maxLength: 80 }).map((suffix) => `arn:aws:dynamodb:us-east-1:012345678901:table/${suffix}`),
      fc.string({ maxLength: 300 }),
    );
    fc.assert(
      fc.property(arn, (value) => {
        const parsed = coordinationTableName(value);
        const expected = /^arn:aws:dynamodb:[^:]+:\d{12}:table\/([A-Za-z0-9_.-]{3,255})$/.exec(value)?.[1];
        assert.deepEqual(parsed.ok ? parsed.value : undefined, expected);
        assert.ok(parsed.ok || parsed.error.detail.length <= MAX_DETAIL);
      }),
      fuzzParameters(),
    );
  });

  it('an admit command reaches admission only with parsed inputs, carried unchanged', async () => {
    const bytes = fc.oneof(
      fc.json().map((text) => new TextEncoder().encode(text)),
      fc.uint8Array({ maxLength: 40 }),
      fc.string({ maxLength: 40 }).map((text) => new TextEncoder().encode(text)),
    );
    await fc.assert(
      fc.asyncProperty(bytes, bytes, flagText, async (payment, decision, variant) => {
        const admitter = new ScriptedExecutionAdmitter(ADMITTED);
        const inputs = new MemoryInputFileReader()
          .place('/operator/p.json', payment)
          .place('/operator/d.json', decision);
        const argv = [
          ...admitSpec('VARIANT_VALIDATION').words,
          ...['--env', 'e.json', '--payment', 'p.json', '--approved-decision', 'd.json', '--variant', variant],
          ...['--probe', PROBE_ID, '--probe-index', 'a'.repeat(64), '--evidence-root', ROOT],
        ];
        const run = await runCli(argv, [new AdmitCommand('VARIANT_VALIDATION', { admit: admitter.admit, inputs })]);
        const parsedPayment = jsonOf(payment);
        const parsedDecision = jsonOf(decision);
        const admissible =
          (variant === 'conventional' || variant === 'durable') && parsedPayment.ok && parsedDecision.ok;
        assert.equal(run.exit_code, admissible ? 0 : 2);
        assert.equal(admitter.calls.length, admissible ? 1 : 0);
        assert.ok(run.result.reasons.every((reason) => reason.detail.length <= MAX_DETAIL));
        if (admissible) {
          assert.deepEqual(admitter.calls[0]?.request.financial_inputs, {
            payment: parsedPayment.value,
            approved_decision: parsedDecision.value,
          });
        }
      }),
      fuzzParameters(),
    );
  });
});

// The reference reading of an input file: fatal UTF-8 decoding, then `JSON.parse`, refusing a
// number that overflows a finite double.
function jsonOf(bytes: Uint8Array): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    return hasNonFiniteNumber(value) ? { ok: false } : { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function hasNonFiniteNumber(value: unknown): boolean {
  if (typeof value === 'number') {
    return !Number.isFinite(value);
  }
  return typeof value === 'object' && value !== null && Object.values(value).some(hasNonFiniteNumber);
}
