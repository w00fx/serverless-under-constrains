// Property target `warmupSettlementProblem` (addendum §2, design §12.5): the provider's response
// to the warm-up is untrusted input. Over arbitrary settlements and payload bytes the check never
// throws, refuses with PROVIDER_WARMUP_FAILED and a bounded detail, and accepts exactly the
// provider's completion of this warm-up from the expected version: a reference model written from
// addendum §2.1 ("status 200, no function error, the published version, a valid
// provider_warmup_completed naming this run, manifest and warm-up") must agree on every input.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { ProviderTransportResult } from '../../../src/provider-client/provider-invocation-port.ts';
import { QUOTED_JSON_LIMIT } from '../../../src/record-contract/json-value.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { warmupSettlementProblem } from '../../../src/trial-execution/runner-warmup.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { warmupCompleted, warmupRequest } from '../../unit/trial-execution/support/trial-execution-fixtures.ts';

const validator = createRecordValidator();
const encoder = new TextEncoder();
const VERSION = '1';
// boundedText keeps QUOTED_JSON_LIMIT characters of each untrusted text (at most two per detail,
// each with its truncation marker); the rest of a detail is fixed prose and the expected values.
const DETAIL_LIMIT = 2 * (QUOTED_JSON_LIMIT + '…[truncated]'.length) + 400;

/** A payload and whether the reference model accepts it. */
interface Payload {
  readonly bytes: Uint8Array;
  readonly accepted: boolean;
}

const correlatedFields = ['run_id', 'execution_manifest_sha256', 'warmup_id'] as const;
const COMPLETION_FIELDS: ReadonlySet<string> = new Set(Object.keys(warmupCompleted()));

const payloads: fc.Arbitrary<Payload> = fc.oneof(
  fc.constant({ bytes: encoder.encode(JSON.stringify(warmupCompleted())), accepted: true }),
  fc.uint8Array({ maxLength: 64 }).map((bytes) => ({ bytes, accepted: false })),
  fc.jsonValue({ maxDepth: 3 }).map((value) => ({ bytes: encoder.encode(JSON.stringify(value)), accepted: false })),
  fc
    .tuple(fc.constantFrom(...correlatedFields), fc.uuid({ version: 4 }))
    .filter(([field, value]) => warmupCompleted()[field] !== value)
    .map(([field, value]) => ({
      bytes: encoder.encode(JSON.stringify(warmupCompleted({ [field]: value }))),
      accepted: false,
    })),
  // Unknown members only (the schema refuses them): an empty or colliding dictionary would be the
  // completion itself, which seed 260610 found as a defect of this generator, not of the check.
  fc
    .dictionary(
      fc.string({ maxLength: 12 }).filter((key) => !COMPLETION_FIELDS.has(key)),
      fc.jsonValue({ maxDepth: 1 }),
      {
        minKeys: 1,
        maxKeys: 3,
      },
    )
    .map((extra) => ({
      bytes: encoder.encode(JSON.stringify({ ...warmupCompleted(), ...(extra as JsonObject) })),
      accepted: false,
    })),
);

interface Case {
  readonly settlement: ProviderTransportResult;
  readonly accepted: boolean;
}

const responses: fc.Arbitrary<Case> = fc
  .record({
    status: fc.oneof(fc.constant(200), fc.integer({ min: 100, max: 599 })),
    functionError: fc.option(fc.string({ maxLength: 4096 }), { nil: undefined, freq: 3 }),
    version: fc.option(fc.oneof(fc.constant(VERSION), fc.string({ maxLength: 4096 })), { nil: undefined, freq: 5 }),
    payload: payloads,
  })
  .map(({ status, functionError, version, payload }) => ({
    settlement: {
      kind: 'response',
      status_code: status,
      function_error: functionError,
      executed_version: version,
      payload: payload.bytes,
    },
    accepted: status === 200 && functionError === undefined && version === VERSION && payload.accepted,
  }));

const transportErrors: fc.Arbitrary<Case> = fc
  .record({ name: fc.string({ maxLength: 4096 }), message: fc.string({ maxLength: 4096 }) })
  .map(({ name, message }) => ({
    settlement: { kind: 'transport_error', error_name: name, message },
    accepted: false,
  }));

describe('warmupSettlementProblem properties', () => {
  it('accepts exactly what the reference model accepts, and refuses everything else with a bounded reason', () => {
    fc.assert(
      fc.property(fc.oneof(responses, transportErrors), ({ settlement, accepted }) => {
        const problem = warmupSettlementProblem(settlement, warmupRequest(), VERSION, validator);
        if (accepted) {
          return problem === undefined;
        }
        return problem?.code === 'PROVIDER_WARMUP_FAILED' && problem.detail.length <= DETAIL_LIMIT;
      }),
      fuzzParameters(),
    );
  });

  it('is a function of its input: the same settlement always gets the same answer', () => {
    fc.assert(
      fc.property(fc.oneof(responses, transportErrors), ({ settlement }) => {
        const first = warmupSettlementProblem(settlement, warmupRequest(), VERSION, validator);
        assert.deepEqual(warmupSettlementProblem(settlement, warmupRequest(), VERSION, validator), first);
      }),
      fuzzParameters(),
    );
  });
});
