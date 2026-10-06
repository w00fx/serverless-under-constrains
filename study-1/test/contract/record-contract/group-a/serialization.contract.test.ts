// AC-RUA-046 serialization rules (BR-RUA-033) proven on every group A record type through the
// committed schemas: casing, millisecond UTC timestamps, lowercase UUIDv4 identifiers,
// safe-integer amounts, decimal strings, omitted versus null, and the schema_version and
// record_type header. Case names follow design §14, row AC-RUA-046.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseJsonDocument } from '../../../../src/record-contract/parsing.ts';
import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import { RECORD_TYPE_GROUPS } from '../../../../src/record-contract/record-types.ts';
import { failedPreflightCheck, passedPreflightCheck, sourceProvenance } from './support/admission-examples.ts';
import {
  detachedSourceProvenance,
  inVariantValidation,
  validationResourceManifest,
  validationTrialManifest,
} from './support/branch-examples.ts';
import { CANONICAL_EXAMPLES, allValidExamples } from './support/canonical-examples.ts';
import {
  payment,
  probeProviderRefundCall,
  rejectedResponse,
  trialMessage,
  trialProviderRefundCall,
} from './support/input-examples.ts';
import {
  failedResourceManifest,
  probeExecutionManifest,
  runExecutionManifest,
  succeededResourceManifest,
  probeProviderExecutionConfiguration,
  trialProviderConfiguration,
  validationProviderExecutionConfiguration,
  trialRegistration,
  validationExecutionManifest,
} from './support/manifest-examples.ts';
import {
  asJson,
  assertAccepted,
  assertRejected,
  catalogueValidator,
  violationsOf,
  withField,
  withPath,
  withoutField,
} from './support/validation-assertions.ts';

const GROUP_A = RECORD_TYPE_GROUPS['group-a'];
type Path = readonly (string | number)[];
interface FieldSite {
  readonly type: (typeof GROUP_A)[number];
  readonly path: Path;
  /** The example that carries the site, when the canonical one takes another branch. */
  readonly example?: () => JsonObject;
}

// Every object member name at any depth, with its JSON Pointer for the assertion label. No
// member is exempt: foreign payloads (CloudFormation and AWS configuration) are carried as
// canonical JSON text, so their names never become record property names.
function memberNames(value: JsonValue, path: string): readonly (readonly [string, string])[] {
  if (Array.isArray(value)) {
    return value.flatMap((item: JsonValue, index) => memberNames(item, `${path}/${String(index)}`));
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([name, child]) => [
    [name, `${path}/${name}`] as const,
    ...memberNames(child, `${path}/${name}`),
  ]);
}

const camelCase = (name: string): string =>
  name.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
const pointer = (path: Path): string => `/${path.join('/')}`;

const TIMESTAMP_SITES: readonly FieldSite[] = [
  { type: 'admission_rejection', path: ['rejected_at'] },
  { type: 'preflight_check_recorded', path: ['checked_at'] },
  { type: 'source_provenance', path: ['recorded_at'] },
  { type: 'deployment_assembly_inventory', path: ['inventoried_at'] },
  { type: 'execution_manifest', path: ['frozen_at'] },
  { type: 'resource_manifest', path: ['deploy_started_at'] },
  { type: 'resource_manifest', path: ['deploy_completed_at'] },
  { type: 'resource_manifest', path: ['frozen_at'] },
  { type: 'trial_manifest', path: ['frozen_at'] },
  { type: 'provider_trial_configuration', path: ['written_at'] },
  { type: 'provider_execution_configuration', path: ['written_at'] },
  { type: 'trial_registration', path: ['registered_at'] },
];

const VARIANT_VALIDATION_ID: Path = ['variant_validation_id'];
const VARIANT_VALIDATION_SITES: readonly FieldSite[] = [
  { type: 'trial_message', path: VARIANT_VALIDATION_ID, example: () => inVariantValidation(trialMessage()) },
  {
    type: 'provider_refund_call',
    path: VARIANT_VALIDATION_ID,
    example: () => inVariantValidation(trialProviderRefundCall()),
  },
  { type: 'execution_manifest', path: VARIANT_VALIDATION_ID, example: () => asJson(validationExecutionManifest()) },
  { type: 'resource_manifest', path: VARIANT_VALIDATION_ID, example: validationResourceManifest },
  { type: 'trial_manifest', path: VARIANT_VALIDATION_ID, example: validationTrialManifest },
  {
    type: 'provider_trial_configuration',
    path: VARIANT_VALIDATION_ID,
    example: () => inVariantValidation(trialProviderConfiguration()),
  },
  { type: 'trial_registration', path: VARIANT_VALIDATION_ID, example: () => inVariantValidation(trialRegistration()) },
  {
    type: 'provider_execution_configuration',
    path: VARIANT_VALIDATION_ID,
    example: () => asJson(validationProviderExecutionConfiguration()),
  },
];

const UUID_SITES: readonly FieldSite[] = [
  { type: 'trial_message', path: ['run_id'] },
  { type: 'trial_message', path: ['trial_id'] },
  { type: 'provider_refund_call', path: ['attempt_id'] },
  { type: 'provider_refund_call', path: ['provider_request_id'] },
  { type: 'provider_refund_response', path: ['provider_call_id'] },
  { type: 'provider_refund_response', path: ['provider_transaction_id'] },
  { type: 'probe_workload_request', path: ['transport_probe_id'] },
  { type: 'admission_rejection', path: ['admission_attempt_id'] },
  { type: 'preflight_check_recorded', path: ['admission_attempt_id'] },
  { type: 'source_provenance', path: ['admission_attempt_id'] },
  { type: 'execution_manifest', path: ['run_id'] },
  { type: 'execution_manifest', path: ['trials', 2, 'trial_id'] },
  { type: 'execution_manifest', path: ['qualification', 'transport_probe_id'] },
  { type: 'resource_manifest', path: ['run_id'] },
  { type: 'trial_manifest', path: ['trial_id'] },
  { type: 'provider_trial_configuration', path: ['trial_id'] },
  { type: 'provider_execution_configuration', path: ['run_id'] },
  {
    type: 'provider_execution_configuration',
    path: ['transport_probe_id'],
    example: () => asJson(probeProviderExecutionConfiguration()),
  },
  { type: 'trial_registration', path: ['trial_id'] },
  // BR-RUA-033 names the variant-validation identity too: every record that can carry it.
  ...VARIANT_VALIDATION_SITES,
];

// Fixed lowercase v4 identifiers, one per RFC 9562 variant nibble (8, 9, a, b), so the case is
// repeatable instead of drawing crypto.randomUUID() on every run.
const VALID_UUID4S: readonly string[] = [
  '00000000-0000-4000-8000-000000000000',
  'ffffffff-ffff-4fff-9fff-ffffffffffff',
  '3f1c2a9e-8b4d-4c1e-af00-1a2b3c4d5e6f',
  '0a1b2c3d-4e5f-4a7b-bc9d-0e1f2a3b4c5d',
];

const AMOUNT_SITES: readonly FieldSite[] = [
  { type: 'payment', path: ['captured_amount_minor'] },
  { type: 'approved_decision', path: ['approved_amount_minor'] },
  { type: 'provider_refund_call', path: ['amount_minor'] },
  { type: 'probe_workload_request', path: ['amount_minor'] },
  { type: 'execution_manifest', path: ['financial_inputs', 'captured_amount_minor'] },
  { type: 'execution_manifest', path: ['financial_inputs', 'approved_amount_minor'] },
];

describe('AC-RUA-046 serialization rules (group A)', () => {
  it('casing', () => {
    for (const { name, record } of allValidExamples()) {
      for (const [member, pointerToMember] of memberNames(record, '')) {
        assert.match(member, /^[a-z][a-z0-9_]*$/, `${name}: ${pointerToMember}`);
      }
    }
    // Nested free values keep the casing rule too.
    assertRejected(
      withPath(failedPreflightCheck(), ['observed'], { ApprovedAmountMinor: 5000 }),
      '/observed propertyNames',
      'PascalCase member in an observed value',
    );
    assertRejected(
      withPath(passedPreflightCheck(), ['expected'], { limits: [{ 'ceiling-usd': '5.00' }] }),
      '/expected/limits/0 propertyNames',
      'kebab-case member deep in an expected value',
    );
    assertAccepted(
      withPath(passedPreflightCheck(), ['expected'], { limits: [{ ceiling_usd: '5.00' }], strict: true }),
      'nested snake_case members',
    );
    for (const type of GROUP_A) {
      const example = CANONICAL_EXAMPLES[type]();
      const renameable = Object.keys(example).filter((key) => key !== 'record_type' && camelCase(key) !== key);
      for (const field of renameable) {
        const renamed = { ...withoutField(example, field), [camelCase(field)]: example[field] ?? null };
        assertRejected(renamed, ' additionalProperties', `${type}: camelCase ${field}`);
      }
      assert.deepEqual(
        violationsOf(catalogueValidator.validate(withField(example, 'record_type', type.toUpperCase()))),
        ['/record_type record_type'],
      );
    }
    // Domain and lifecycle enum values stay uppercase.
    assertRejected(withField(payment(), 'currency', 'brl'), '/currency const', 'lowercase currency');
    assertRejected(
      withField(CANONICAL_EXAMPLES.approved_decision(), 'decision', 'approved'),
      '/decision const',
      'decision',
    );
    assertRejected(
      withField(runExecutionManifest(), 'execution_kind', 'run'),
      '/execution_kind enum',
      'execution kind',
    );
    assertRejected(
      withPath(runExecutionManifest(), ['timing', 'retry_jitter'], 'none'),
      '/timing/retry_jitter const',
      'jitter',
    );
    assertRejected(
      withField(rejectedResponse(), 'rejection_reason', 'currency_mismatch'),
      '/rejection_reason enum',
      'reason',
    );
    assertRejected(withField(CANONICAL_EXAMPLES.trial_manifest(), 'scenario', 'control'), '/scenario enum', 'scenario');
    assertRejected(
      withField(CANONICAL_EXAMPLES.provider_refund_response(), 'outcome', 'succeeded'),
      '/outcome enum',
      'outcome',
    );
    // Operational statuses and identifiers of variants and callers stay lowercase.
    assertRejected(
      withField(succeededResourceManifest(), 'provisioning_status', 'SUCCEEDED'),
      '/provisioning_status enum',
      'status',
    );
    assertRejected(withField(passedPreflightCheck(), 'result', 'PASSED'), '/result enum', 'preflight result');
    assertRejected(
      withField(CANONICAL_EXAMPLES.trial_registration(), 'variant_id', 'Conventional'),
      '/variant_id enum',
      'variant',
    );
    assertRejected(withField(probeProviderRefundCall(), 'caller_id', 'PROBE'), '/caller_id const', 'caller');
  });

  it('millisecond UTC', () => {
    for (const { type, path } of TIMESTAMP_SITES) {
      const example = CANONICAL_EXAMPLES[type]();
      assertAccepted(withPath(example, path, '2026-10-05T23:59:59.999Z'), `${type} ${pointer(path)}`);
      for (const value of [
        '2026-10-05T12:00:00Z',
        '2026-10-05T12:00:00.000123Z',
        '2026-10-05T12:00:00.000+00:00',
        '2026-10-05T12:00:00.000z',
        '2026-10-05 12:00:00.000Z',
      ]) {
        assertRejected(withPath(example, path, value), `${pointer(path)} pattern`, `${type} ${value}`);
      }
      assertRejected(withPath(example, path, '2026-02-30T12:00:00.000Z'), `${pointer(path)} format`, `${type} Feb 30`);
      assertRejected(withPath(example, path, 1791230400000), `${pointer(path)} type`, `${type} epoch number`);
    }
  });

  it('lowercase UUIDv4', () => {
    assert.equal(VARIANT_VALIDATION_SITES.length, 8);
    for (const { type, path, example: branchExample } of UUID_SITES) {
      const example = (branchExample ?? CANONICAL_EXAMPLES[type])();
      for (const value of VALID_UUID4S) {
        assertAccepted(withPath(example, path, value), `${type} ${pointer(path)} ${value}`);
      }
      for (const value of [
        '3F1C2A9E-8B4D-4C1E-9F00-1A2B3C4D5E6F',
        '3f1c2a9e-8b4d-1c1e-9f00-1a2b3c4d5e6f',
        '3f1c2a9e-8b4d-4c1e-cf00-1a2b3c4d5e6f',
        '3f1c2a9e8b4d4c1e9f001a2b3c4d5e6f',
        '{3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f}',
        'ref-poc-001',
      ]) {
        assertRejected(withPath(example, path, value), `${pointer(path)} pattern`, `${type} ${pointer(path)} ${value}`);
      }
    }
  });

  it('safe-integer amounts', () => {
    for (const { type, path } of AMOUNT_SITES) {
      const example = CANONICAL_EXAMPLES[type]();
      assertAccepted(withPath(example, path, 9007199254740991), `${type}: max safe integer`);
      assertAccepted(withPath(example, path, 1), `${type}: one minor unit`);
      assertRejected(withPath(example, path, 9007199254740992), `${pointer(path)} maximum`, `${type}: 2^53`);
      assertRejected(withPath(example, path, 0), `${pointer(path)} minimum`, `${type}: zero`);
      assertRejected(withPath(example, path, -10000), `${pointer(path)} minimum`, `${type}: negative`);
      assertRejected(withPath(example, path, 100.5), `${pointer(path)} type`, `${type}: fraction`);
      assertRejected(withPath(example, path, '10000'), `${pointer(path)} type`, `${type}: string amount`);
    }
    const parsed = parseJsonDocument(
      new TextEncoder().encode(
        '{"schema_version":1,"record_type":"payment","payment_id":"pay-poc-001","captured_amount_minor":10000.0,"currency":"BRL"}',
      ),
    );
    assert.ok(parsed.ok);
    assert.deepEqual(violationsOf(catalogueValidator.validate(parsed.value)), [], 'integral JSON number 10000.0');
  });

  it('decimal aggregates', () => {
    // Group A carries no minor-unit aggregate; its decimal strings are the USD money values of
    // the execution manifest (OR-RUA-003..005 ceilings and the admission estimate).
    for (const path of [
      ['safety', 'ceiling_usd'],
      ['estimates', 'estimated_cost_usd'],
    ]) {
      for (const value of ['5.00', '0', '0.0000166667', '18014398509481982.5']) {
        assertAccepted(withPath(runExecutionManifest(), path, value), `${pointer(path)} ${value}`);
      }
      for (const value of ['01', '-1', '.5', '5.', '1e3', ' 5.00', '']) {
        assertRejected(
          withPath(runExecutionManifest(), path, value),
          `${pointer(path)} pattern`,
          `${pointer(path)} ${value}`,
        );
      }
      assertRejected(withPath(runExecutionManifest(), path, 5), `${pointer(path)} type`, `${pointer(path)} number`);
    }
  });

  it('omitted versus null', () => {
    const detached = detachedSourceProvenance();
    assertAccepted(detached, 'branch omitted on a detached HEAD');
    assertRejected(withField(sourceProvenance(), 'branch', null), '/branch type', 'branch as null');
    assertAccepted(withoutField(failedPreflightCheck(), 'observed'), 'observed omitted when unavailable');
    assertRejected(withField(failedPreflightCheck(), 'observed', null), '/observed anyOf', 'observed as null');
    assertRejected(withField(failedPreflightCheck(), 'expected', null), '/expected anyOf', 'expected as null');
    assertRejected(
      withPath(failedPreflightCheck(), ['observed', 'approved_amount_minor'], null),
      '/observed/approved_amount_minor anyOf',
      'null nested in an observed value',
    );
    assertRejected(
      withPath(passedPreflightCheck(), ['expected'], [null]),
      '/expected/0 anyOf',
      'null item in an expected value',
    );
    for (const side of ['conventional', 'durable']) {
      assertRejected(
        withPath(runExecutionManifest(), ['declared_variant_differences', 0, side], null),
        `/declared_variant_differences/0/${side} anyOf`,
        `${side} side of a declared difference as null`,
      );
    }
    assertRejected(
      withPath(validationExecutionManifest(), ['qualification', 'amendment_head_sha256'], null),
      '/qualification/amendment_head_sha256 type',
      'amendment head as null instead of omitted',
    );
    assertRejected(
      withPath(succeededResourceManifest(), ['resources', 0, 'physical_id'], null),
      '/resources/0/physical_id type',
      'physical id',
    );
    assertRejected(withField(failedResourceManifest(), 'stack_id', null), '/stack_id type', 'stack id as null');
    const anonymousRejection = withoutField(withoutField(rejectedResponse(), 'attempt_id'), 'provider_request_id');
    assertAccepted(anonymousRejection, 'unechoed caller identities are omitted');
    assertRejected(withField(rejectedResponse(), 'attempt_id', null), '/attempt_id type', 'attempt id as null');
    // null only where absence has meaning: a probe consumes no qualification.
    assertAccepted(probeExecutionManifest(), 'probe qualification null');
    assertRejected(withField(runExecutionManifest(), 'qualification', null), '/qualification type', 'run without one');
    assertRejected(
      withField(probeExecutionManifest(), 'qualification', runExecutionManifest().qualification),
      '/qualification type',
      'probe with a qualification object',
    );
    // Required collections serialize as [] and are never omitted.
    assertAccepted(passedPreflightCheck(), 'empty reasons and evidence_refs');
    assertRejected(withoutField(passedPreflightCheck(), 'reasons'), ' required', 'reasons omitted');
    assertRejected(withoutField(passedPreflightCheck(), 'evidence_refs'), ' required', 'evidence_refs omitted');
    assertRejected(withoutField(probeExecutionManifest(), 'trials'), ' required', 'probe trials omitted');
    assertAccepted(withField(runExecutionManifest(), 'declared_variant_differences', []), 'no declared difference');
    assertRejected(
      withoutField(runExecutionManifest(), 'declared_variant_differences'),
      ' required',
      'omitted differences',
    );
    assertAccepted(failedResourceManifest(), 'empty resources and outputs');
    assertRejected(withoutField(failedResourceManifest(), 'outputs'), ' required', 'outputs omitted');
  });

  it('schema_version and record_type present', () => {
    for (const type of GROUP_A) {
      const example = CANONICAL_EXAMPLES[type]();
      assertRejected(withoutField(example, 'schema_version'), ' required', `${type}: missing schema_version`);
      assertRejected(withField(example, 'schema_version', 2), '/schema_version const', `${type}: schema_version 2`);
      assertRejected(withField(example, 'schema_version', '1'), '/schema_version const', `${type}: string version`);
      assert.deepEqual(violationsOf(catalogueValidator.validate(withoutField(example, 'record_type'))), [
        '/record_type record_type',
      ]);
      assert.deepEqual(violationsOf(catalogueValidator.validateAs(type, withoutField(example, 'record_type'))), [
        '/record_type record_type',
      ]);
    }
  });
});
