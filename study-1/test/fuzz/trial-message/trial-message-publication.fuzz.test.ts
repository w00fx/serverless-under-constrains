// Property-based tests of the pre-publication check (testing rule 6; BR-RUA-036): the runner
// passes it the exact bytes it is about to publish, so it must judge any bytes without throwing
// and with closed codes, and it must find nothing wrong with the canonical bytes of any frozen
// trial, while any single-field change to those bytes is reported.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { Sha256Hex, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import {
  PUBLICATION_MISMATCH_CODES,
  buildTrialMessage,
  validateBeforePublication,
} from '../../../src/trial-message/trial-message-publication.ts';
import type { TrialManifest } from '../../../src/record-contract/records/group-a/trial_manifest.ts';
import type { TrialPublication } from '../../../src/trial-message/trial-message-publication.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { runPublication, runTrialManifest } from '../../unit/trial-message/support/trial-message-fixtures.ts';

const validator = createRecordValidator();
const uuid = fc.uuid({ version: 4 }).map((id) => id as Uuid4);
const digest = fc.stringMatching(/^[0-9a-f]{64}$/u).map((hex) => hex as Sha256Hex);
const identifier = fc.stringMatching(/^[a-z0-9][a-z0-9 -]{0,20}[a-z0-9]$/u);

const publication: fc.Arbitrary<TrialPublication> = fc
  .record({ run: uuid, trial: uuid, digest, payment: identifier, refund: identifier })
  .map(({ run, trial, digest: trialDigest, payment, refund }) => ({
    trial: { ...runTrialManifest(), run_id: run, trial_id: trial } as TrialManifest,
    trial_manifest_sha256: trialDigest,
    request: { payment_id: payment, refund_request_id: refund },
  }));

describe('pre-publication check properties', () => {
  it('finds nothing wrong with the canonical bytes of any frozen trial', () => {
    fc.assert(
      fc.property(publication, (frozen) => {
        assert.deepEqual(validateBeforePublication(buildTrialMessage(frozen).bytes, frozen, validator), []);
      }),
      fuzzParameters(),
    );
  });

  it('reports the bytes of another trial as at least one mismatch', () => {
    fc.assert(
      fc.property(publication, publication, (published, frozen) => {
        const reasons = validateBeforePublication(buildTrialMessage(published).bytes, frozen, validator);
        const same =
          JSON.stringify(buildTrialMessage(published).record) === JSON.stringify(buildTrialMessage(frozen).record);
        assert.equal(reasons.length === 0, same);
      }),
      fuzzParameters(),
    );
  });

  it('judges any bytes without throwing, with closed codes and bounded details', () => {
    const canonical = buildTrialMessage(runPublication()).bytes;
    const bytes = fc.oneof(
      fc.uint8Array({ maxLength: 300 }),
      fc.string().map((text) => new TextEncoder().encode(text)),
      fc
        .tuple(fc.nat({ max: canonical.length - 1 }), fc.integer({ min: 0, max: 255 }))
        .map(([index, byte]) => canonical.map((value, at) => (at === index ? byte : value))),
    );
    fc.assert(
      fc.property(bytes, (candidate) => {
        for (const reason of validateBeforePublication(candidate, runPublication(), validator)) {
          assert.ok((PUBLICATION_MISMATCH_CODES as readonly string[]).includes(reason.code));
          assert.equal(reason.subject, 'BR-RUA-036');
          assert.ok(reason.detail.length > 0 && reason.detail.length < 4_000);
        }
      }),
      fuzzParameters(),
    );
  });
});
