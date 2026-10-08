// What provisioning reads after `cdk deploy`, decided from the frozen assembly (design §9.8 D4;
// BR-RUA-040, BR-RUA-050, BR-RUA-053; addendum §2.4): the declared stack tags of the cloud-assembly
// manifest, the planned reads of the template, their resolution to physical ids, and the
// configuration snapshot with a reason for every failed read, existing provisioned concurrency and
// mismatched version.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  configurationSnapshotOf,
  declaredStackTags,
  planPostDeployReads,
  resolveReadRequests,
} from '../../../src/deployment-assembly/configuration-reading-plan.ts';
import type { PlannedRead, ReadRequest } from '../../../src/deployment-assembly/configuration-reading-plan.ts';
import { RUN_STACK } from '../../support/deployment-assembly/deployment-fixtures.ts';
import {
  FIXTURE_IDS,
  removeResource,
  resourceAt,
  runTemplate,
  templateBytes,
} from '../../support/deployment-assembly/execution-template-fixture.ts';
import { DEEP_NESTING, towerText } from '../../support/kernel/deep-json.ts';

const encoder = new TextEncoder();
const VERSION_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:suc1-3f1c2a9e-provider:7';
const ALIAS_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:suc1-3f1c2a9e-caller:live';
const MAPPING_UUID = '5a0e1c2d-0000-4000-8000-000000000001';
const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/suc1-3f1c2a9e-source.fifo';

function manifestBytes(tags: unknown, stack = RUN_STACK): Uint8Array {
  return encoder.encode(JSON.stringify({ version: '54.0.0', artifacts: { [stack]: { properties: { tags } } } }));
}

function listed(
  logicalId: string,
  physicalId?: string,
): {
  logical_id: string;
  resource_type: string;
  physical_id?: string;
  resource_status: string;
} {
  return {
    logical_id: logicalId,
    resource_type: 'AWS::X::Y',
    ...(physicalId === undefined ? {} : { physical_id: physicalId }),
    resource_status: 'CREATE_COMPLETE',
  };
}

describe('declaredStackTags', () => {
  it('reads the stack tags of the cloud-assembly manifest, sorted by key', () => {
    assert.deepEqual(declaredStackTags(manifestBytes({ 'suc:study_id': 'study-1', 'suc:project': 'p' }), RUN_STACK), {
      ok: true,
      value: [
        { key: 'suc:project', value: 'p' },
        { key: 'suc:study_id', value: 'study-1' },
      ],
    });
  });

  it('refuses bytes that are not JSON, another stack, absent tags and non-string values', () => {
    const refused = [
      encoder.encode('{'),
      new Uint8Array([0xff]),
      manifestBytes({ 'suc:project': 'p' }, 'SucRua-run-00000000'),
      manifestBytes(undefined),
      manifestBytes(['suc:project']),
      manifestBytes({ 'suc:project': 1 }),
      encoder.encode('{"artifacts":{"__proto__":{"properties":{"tags":{}}}}}'),
    ];
    for (const bytes of refused) {
      const tags = declaredStackTags(bytes, RUN_STACK);
      assert.deepEqual(tags.ok ? [] : [tags.error.code, tags.error.subject], [
        'DECLARED_TAGS_UNREADABLE',
        'BR-RUA-050',
      ]);
    }
    const detail = declaredStackTags(manifestBytes({ 'suc:project': 1 }), RUN_STACK);
    assert.match(
      detail.ok ? '' : detail.error.detail,
      /expected artifacts\."SucRua-run-3f1c2a9e"\.properties\.tags as an object of string values$/,
    );
  });

  // A-05 regressions (CMP-02 single-pass review): the frozen manifest is untrusted package bytes.
  it('reads 100,000-level tag towers as one bounded reason, never a RangeError', () => {
    for (const shape of ['array', 'object', 'mixed'] as const) {
      const tower = towerText(shape, DEEP_NESTING, '"v"');
      for (const text of [
        `{"artifacts":{"${RUN_STACK}":{"properties":{"tags":${tower}}}}}`,
        `{"artifacts":{"${RUN_STACK}":{"properties":{"tags":{"suc:project":${tower}}}}}}`,
      ]) {
        const tags = declaredStackTags(encoder.encode(text), RUN_STACK);
        assert.equal(tags.ok ? 'ok' : tags.error.code, 'DECLARED_TAGS_UNREADABLE', shape);
        assert.ok(tags.ok || tags.error.detail.length < 1_000, shape);
      }
    }
  });

  it('names a manifest that is not JSON, a number past the double range included', () => {
    const tags = declaredStackTags(
      encoder.encode(`{"artifacts":{"${RUN_STACK}":{"properties":{"tags":{"suc:project":1e400}}}}}`),
      RUN_STACK,
    );
    assert.match(tags.ok ? '' : tags.error.detail, /^manifest\.json is not one JSON document \(invalid_json\); /);
    const binary = declaredStackTags(new Uint8Array([0xff]), RUN_STACK);
    assert.match(binary.ok ? '' : binary.error.detail, /^manifest\.json is not one JSON document \(invalid_utf8\); /);
  });

  it('never reads an inherited member name as a declared stack', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const tags = declaredStackTags(encoder.encode('{"artifacts":{}}'), name);
      assert.equal(tags.ok ? 'ok' : tags.error.code, 'DECLARED_TAGS_UNREADABLE', name);
    }
  });
});

describe('planPostDeployReads', () => {
  it('plans the provider version, every mapping, queue, table, version and alias, sorted', () => {
    const plan = planPostDeployReads(templateBytes(runTemplate()));
    assert.ok(plan.ok);
    assert.equal(plan.value.provider_version_logical_id, FIXTURE_IDS.providerVersion);
    assert.deepEqual(plan.value.reads, [
      { kind: 'table', logical_id: FIXTURE_IDS.callerJournalTable },
      { kind: 'queue', logical_id: FIXTURE_IDS.controllerFailure },
      { kind: 'event_source_mapping', logical_id: FIXTURE_IDS.controllerMapping },
      { kind: 'provisioned_concurrency', logical_id: FIXTURE_IDS.conventionalAlias },
      { kind: 'queue', logical_id: FIXTURE_IDS.conventionalDeadLetter },
      { kind: 'event_source_mapping', logical_id: FIXTURE_IDS.conventionalMapping },
      { kind: 'queue', logical_id: FIXTURE_IDS.conventionalSource },
      { kind: 'provisioned_concurrency', logical_id: FIXTURE_IDS.durableAlias },
      { kind: 'queue', logical_id: FIXTURE_IDS.durableDeadLetter },
      { kind: 'event_source_mapping', logical_id: FIXTURE_IDS.durableMapping },
      { kind: 'queue', logical_id: FIXTURE_IDS.durableSource },
      { kind: 'function_configuration', logical_id: FIXTURE_IDS.providerVersion },
      { kind: 'provisioned_concurrency', logical_id: FIXTURE_IDS.providerVersion },
    ]);
  });

  it('ignores resource types it does not read, even under an inherited type name', () => {
    const template = runTemplate();
    resourceAt(template, FIXTURE_IDS.controllerFailure)['Type'] = 'constructor';
    const plan = planPostDeployReads(templateBytes(template));
    assert.ok(plan.ok);
    assert.ok(!plan.value.reads.some((read) => read.logical_id === FIXTURE_IDS.controllerFailure));
  });

  it('refuses a template that is not a template, or has no provider version', () => {
    assert.equal(planPostDeployReads(encoder.encode('[]')).ok, false);
    const template = runTemplate();
    removeResource(template, FIXTURE_IDS.providerVersion);
    const plan = planPostDeployReads(templateBytes(template));
    assert.equal(plan.ok ? undefined : plan.error.code, 'TEMPLATE_RESOURCE_MISSING');
  });
});

describe('resolveReadRequests', () => {
  const reads: readonly PlannedRead[] = [
    { kind: 'function_configuration', logical_id: 'ProviderVersion' },
    { kind: 'provisioned_concurrency', logical_id: 'CallerAlias' },
    { kind: 'event_source_mapping', logical_id: 'Mapping' },
    { kind: 'queue', logical_id: 'Queue' },
    { kind: 'table', logical_id: 'Table' },
  ];

  it('resolves each read to the identifiers its request names', () => {
    const resolved = resolveReadRequests(reads, [
      listed('ProviderVersion', VERSION_ARN),
      listed('CallerAlias', ALIAS_ARN),
      listed('Mapping', MAPPING_UUID),
      listed('Queue', QUEUE_URL),
      listed('Table', 'suc1-3f1c2a9e-ledger'),
    ]);
    assert.deepEqual(resolved, {
      requests: [
        {
          kind: 'function_configuration',
          logical_id: 'ProviderVersion',
          function_name: 'suc1-3f1c2a9e-provider',
          qualifier: '7',
        },
        {
          kind: 'provisioned_concurrency',
          logical_id: 'CallerAlias',
          function_name: 'suc1-3f1c2a9e-caller',
          qualifier: 'live',
        },
        { kind: 'event_source_mapping', logical_id: 'Mapping', uuid: MAPPING_UUID },
        { kind: 'queue', logical_id: 'Queue', queue_url: QUEUE_URL },
        { kind: 'table', logical_id: 'Table', table_name: 'suc1-3f1c2a9e-ledger' },
      ],
      reasons: [],
    });
  });

  it('gives a reason for every read not listed or whose physical id has another form', () => {
    const resolved = resolveReadRequests(reads, [
      listed('ProviderVersion', 'suc1-3f1c2a9e-provider'),
      listed('CallerAlias', `${ALIAS_ARN}:extra`),
      listed('Mapping', MAPPING_UUID.toUpperCase()),
      listed('Queue'),
    ]);
    assert.deepEqual(resolved.requests, []);
    assert.deepEqual(
      resolved.reasons.map((reason) => [reason.code, reason.subject]),
      Array.from({ length: 5 }, () => ['READ_TARGET_UNRESOLVED', 'BR-RUA-040']),
    );
    assert.match(resolved.reasons[3]?.detail ?? '', /^queue read of Queue is physical id null;/);
    assert.match(resolved.reasons[4]?.detail ?? '', /^table read of Table is not listed;/);
    const table = resolveReadRequests([{ kind: 'table', logical_id: 'Table' }], [listed('Table', 'a b')]);
    assert.equal(table.reasons.length, 1);
  });
});

describe('configurationSnapshotOf', () => {
  const version: ReadRequest = {
    kind: 'function_configuration',
    logical_id: 'ProviderVersion',
    function_name: 'suc1-3f1c2a9e-provider',
    qualifier: '7',
  };
  const alias: ReadRequest = {
    ...version,
    kind: 'provisioned_concurrency',
    logical_id: 'CallerAlias',
    qualifier: 'live',
  };
  const queue: ReadRequest = { kind: 'queue', logical_id: 'Queue', queue_url: QUEUE_URL };

  it('records every answered attribute under its logical id', () => {
    const snapshot = configurationSnapshotOf([
      { request: version, answer: { ok: true, value: [{ attribute_path: 'Version', value: '7' }] } },
      {
        request: alias,
        answer: { ok: true, value: [{ attribute_path: 'ProvisionedConcurrencyConfig', value: null }] },
      },
      { request: queue, answer: { ok: true, value: [{ attribute_path: 'Version', value: 'other' }] } },
    ]);
    assert.deepEqual(snapshot, {
      readings: [
        { logical_id: 'ProviderVersion', attribute_path: 'Version', value: '7' },
        { logical_id: 'CallerAlias', attribute_path: 'ProvisionedConcurrencyConfig', value: null },
        { logical_id: 'Queue', attribute_path: 'Version', value: 'other' },
      ],
      reasons: [],
    });
  });

  it('gives a reason for a failed read, provisioned concurrency and a mismatched version', () => {
    const snapshot = configurationSnapshotOf([
      { request: queue, answer: { ok: false, error: { code: 'QueueDoesNotExist', detail: 'gone' } } },
      {
        request: alias,
        answer: { ok: true, value: [{ attribute_path: 'ProvisionedConcurrencyConfig', value: { Status: 'READY' } }] },
      },
      { request: version, answer: { ok: true, value: [{ attribute_path: 'Version', value: '8' }] } },
    ]);
    assert.deepEqual(snapshot.readings.length, 2);
    assert.deepEqual(
      snapshot.reasons.map((reason) => [reason.code, reason.subject, reason.detail]),
      [
        [
          'CONFIGURATION_READ_FAILED',
          'BR-RUA-040',
          'queue read of Queue failed with QueueDoesNotExist: gone; expected its post-deploy configuration',
        ],
        [
          'PROVISIONED_CONCURRENCY_PRESENT',
          'BR-RUA-053',
          'CallerAlias has provisioned concurrency {"Status":"READY"}; expected none on any function (addendum §2.4)',
        ],
        [
          'PROVIDER_VERSION_MISMATCH',
          'BR-RUA-053',
          'ProviderVersion reports version "8"; expected the listed version 7',
        ],
      ],
    );
  });
});
