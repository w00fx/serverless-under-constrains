// The discovery targets of one execution (BR-RUA-050, BR-RUA-051; design §9.7, §9.14): derived
// from the frozen resource manifest and the execution identity, refused for a manifest of another
// execution, without exactly one `suc:study_id` tag, or with a queue URL that is not one.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_STACK_OUTPUTS } from '../../../infra/stacks/execution-stack.ts';
import {
  logGroupNamePrefix,
  RUN_OWNED_TABLE_ROLES,
  resourceNamePrefix,
  tableName,
} from '../../../infra/ownership/resource-naming.ts';
import {
  DLQ_OUTPUT_KEYS,
  DURABLE_FUNCTION_OUTPUT_KEY,
  discoveryTargetsOf,
} from '../../../src/cleanup/discovery-targets.ts';
import { FUNCTION_VERSION_RESOURCE_TYPE, QUEUE_RESOURCE_TYPE } from '../../../src/cleanup/resource-types.ts';
import type { ResourceManifest } from '../../../src/record-contract/records/group-a/resource_manifest.ts';
import {
  EXECUTION,
  EXECUTION_ID,
  NAMES,
  OTHER_EXECUTION_ID,
  resourceManifest,
  runTags,
  STACK_ID,
  STACK_MEMBERS,
  STACK_NAME,
  STUDY_ID,
} from '../../support/cleanup/cleanup-fixtures.ts';

const ACCOUNT = '123456789012';
const DURABLE_ARN = `arn:aws:lambda:us-east-1:${ACCOUNT}:function:${NAMES.durableFunction}`;
const CONVENTIONAL_DLQ = `https://sqs.us-east-1.amazonaws.com/${ACCOUNT}/suc1-aaaaaaaa-conventional-dlq.fifo`;

function withOutputs(manifest: ResourceManifest, outputs: Readonly<Record<string, string>>): ResourceManifest {
  return { ...manifest, outputs: Object.entries(outputs).map(([key, value]) => ({ key, value })) };
}

function withVersions(manifest: ResourceManifest, arns: readonly string[]): ResourceManifest {
  const versions = arns.map((arn, index) => ({
    logical_id: `Version${String(index)}`,
    resource_type: FUNCTION_VERSION_RESOURCE_TYPE,
    physical_id: arn,
    resource_status: 'CREATE_COMPLETE',
  }));
  return { ...manifest, resources: [...manifest.resources, ...versions] };
}

function reasonOf(manifest: ResourceManifest): string {
  const targets = discoveryTargetsOf({ manifest, execution: EXECUTION });
  if (targets.ok) {
    throw new Error(`expected the manifest to be refused, got targets for ${targets.value.execution_id}`);
  }
  return `${targets.error.code} ${targets.error.subject}: ${targets.error.detail}`;
}

describe('discoveryTargetsOf', () => {
  it('derives every target of a succeeded manifest', () => {
    const manifest = withVersions(
      withOutputs(resourceManifest(), {
        DurableDeadLetterQueueUrl: NAMES.durableDlqUrl,
        ConventionalDeadLetterQueueUrl: CONVENTIONAL_DLQ,
        DurableCallerFunctionName: NAMES.durableFunction,
      }),
      [`${DURABLE_ARN}:3`, `${DURABLE_ARN}:4`, `arn:aws:lambda:us-east-1:${ACCOUNT}:function:other:1`, 'not-an-arn'],
    );
    const targets = discoveryTargetsOf({ manifest, execution: EXECUTION });
    const dlqName = NAMES.durableDlqUrl.slice(NAMES.durableDlqUrl.lastIndexOf('/') + 1);
    assert.deepEqual(targets, {
      ok: true,
      value: {
        execution_id: EXECUTION_ID,
        study_id: STUDY_ID,
        stack_ref: STACK_ID,
        recorded_stack_id: STACK_ID,
        function_names: [NAMES.providerFunction, NAMES.durableFunction],
        durable_functions: [{ function_name: NAMES.durableFunction, qualifiers: ['3', '4'] }],
        event_source_mapping_ids: [NAMES.sourceMapping],
        event_source_arns: [`arn:aws:sqs:us-east-1:${ACCOUNT}:${dlqName}`],
        queue_names: [dlqName],
        queue_name_prefix: resourceNamePrefix(EXECUTION_ID),
        dlq_urls: [CONVENTIONAL_DLQ, NAMES.durableDlqUrl],
        // The recorded names first, then each deterministic name not recorded.
        table_names: [
          NAMES.controlTable,
          ...RUN_OWNED_TABLE_ROLES.map((role) => tableName(EXECUTION_ID, role)).filter(
            (name) => name !== NAMES.controlTable,
          ),
        ],
        log_group_prefix: logGroupNamePrefix(EXECUTION_ID),
        role_names: [NAMES.providerRole],
      },
    });
  });

  it('asks about the stack by name and finds the deterministic names of a partial manifest', () => {
    const manifest = resourceManifest('partial', { members: [], withStack: false });
    const targets = discoveryTargetsOf({ manifest, execution: EXECUTION });
    assert.ok(targets.ok);
    assert.equal(targets.value.stack_ref, STACK_NAME);
    assert.equal(Object.hasOwn(targets.value, 'recorded_stack_id'), false);
    assert.deepEqual(targets.value.function_names, []);
    assert.deepEqual(targets.value.durable_functions, []);
    assert.deepEqual(targets.value.dlq_urls, []);
    assert.deepEqual(
      targets.value.table_names,
      RUN_OWNED_TABLE_ROLES.map((role) => tableName(EXECUTION_ID, role)),
    );
  });

  it('lists each recorded physical id once, skipping entries CloudFormation never assigned one', () => {
    const base = resourceManifest();
    const queueEntry = base.resources.find((entry) => entry.resource_type === QUEUE_RESOURCE_TYPE);
    assert.ok(queueEntry);
    const manifest: ResourceManifest = {
      ...base,
      resources: [
        ...base.resources,
        { ...queueEntry, logical_id: 'Again' },
        { logical_id: 'Unborn', resource_type: QUEUE_RESOURCE_TYPE, resource_status: 'CREATE_FAILED' },
      ],
    };
    const targets = discoveryTargetsOf({ manifest, execution: EXECUTION });
    assert.ok(targets.ok);
    assert.equal(targets.value.queue_names.length, 1);
  });

  it('lists the Durable function unqualified only when no version of it is recorded', () => {
    const manifest = withOutputs(resourceManifest(), { DurableCallerFunctionName: NAMES.durableFunction });
    const targets = discoveryTargetsOf({ manifest, execution: EXECUTION });
    assert.ok(targets.ok);
    assert.deepEqual(targets.value.durable_functions, [{ function_name: NAMES.durableFunction, qualifiers: [] }]);
  });

  it('refuses a manifest of another execution or of another execution kind', () => {
    assert.match(
      reasonOf(resourceManifest('succeeded', { identity: { run_id: OTHER_EXECUTION_ID } })),
      new RegExp(
        `^DISCOVERY_TARGETS_UNRESOLVED BR-RUA-050: resource manifest run_id "${OTHER_EXECUTION_ID}"; expected ${EXECUTION_ID}$`,
      ),
    );
    assert.match(
      reasonOf(resourceManifest('succeeded', { identity: { transport_probe_id: EXECUTION_ID } })),
      /resource manifest run_id "undefined"; expected/,
    );
    const both = { ...resourceManifest(), variant_validation_id: EXECUTION_ID } as ResourceManifest;
    assert.match(reasonOf(both), /resource manifest variant_validation_id "aaaaaaaa-.*"; expected undefined$/);
  });

  it('refuses a manifest without exactly one suc:study_id tag', () => {
    const tags = runTags();
    const withoutStudy = tags.filter((tag) => tag.key !== 'suc:study_id');
    assert.match(
      reasonOf(resourceManifest('succeeded', { tags: withoutStudy })),
      /: 0 suc:study_id tags; expected exactly one$/,
    );
    assert.match(
      reasonOf(resourceManifest('succeeded', { tags: [...tags, { key: 'suc:study_id', value: 'study-2' }] })),
      /: 2 suc:study_id tags; expected exactly one$/,
    );
  });

  it('refuses a recorded queue or a DLQ output that is not an SQS queue URL', () => {
    const base = resourceManifest();
    const badQueue: ResourceManifest = {
      ...base,
      resources: base.resources.map((entry) =>
        entry.resource_type === QUEUE_RESOURCE_TYPE ? { ...entry, physical_id: 'suc1-aaaaaaaa-durable-dlq' } : entry,
      ),
    };
    assert.match(reasonOf(badQueue), /: recorded queue "suc1-aaaaaaaa-durable-dlq"; expected an SQS queue URL/);
    assert.match(
      reasonOf(withOutputs(base, { DurableDeadLetterQueueUrl: 'http://example.test/q' })),
      /: DLQ output "http:\/\/example.test\/q"; expected an SQS queue URL/,
    );
  });

  it('spells the stack output keys the execution stack declares', () => {
    assert.deepEqual(DLQ_OUTPUT_KEYS, [
      EXECUTION_STACK_OUTPUTS.conventionalDeadLetterQueueUrl,
      EXECUTION_STACK_OUTPUTS.durableDeadLetterQueueUrl,
    ]);
    assert.equal(DURABLE_FUNCTION_OUTPUT_KEY, EXECUTION_STACK_OUTPUTS.durableCallerFunctionName);
    assert.equal(STACK_MEMBERS.length > 0, true);
  });
});
