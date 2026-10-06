// Readings of Lambda SDK output (design §9.14, RK-10): functions by name, versions and aliases by
// ARN (untaggable, `$LATEST` never listed), mappings by UUID with state, and RUNNING durable
// executions owned through the stack that manages their function.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DURABLE_EXECUTION_RESOURCE_TYPE,
  FUNCTION_ALIAS_RESOURCE_TYPE,
  FUNCTION_VERSION_RESOURCE_TYPE,
} from '../../../src/cleanup/resource-types.ts';
import { MALFORMED_OUTPUT } from '../../../src/cleanup/surface-readings.ts';
import {
  durableExecutionsPage,
  durableStatusReading,
  functionAliasesPage,
  functionReading,
  functionVersionsPage,
  LATEST_VERSION,
  mappingReading,
  mappingsPage,
  qualifiedFunctionParts,
  runningExecutionArnsPage,
} from '../../../src/cleanup/surface-readings-lambda.ts';
import { ok } from '../../../src/record-contract/primitives.ts';
import { STACK_ID } from '../../support/cleanup/cleanup-fixtures.ts';

const FUNCTION_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:suc1-aaaaaaaa-durable-caller';
const EXECUTION_ARN = `${FUNCTION_ARN}:3/durable-execution/run-1/0f0e`;

function malformed(
  subject: string,
  detail: string,
): { ok: false; error: { code: string; subject: string; detail: string } } {
  return { ok: false, error: { code: MALFORMED_OUTPUT, subject, detail } };
}

describe('qualifiedFunctionParts', () => {
  it('splits a version or alias ARN into the function ARN, name and qualifier', () => {
    assert.deepEqual(qualifiedFunctionParts(`${FUNCTION_ARN}:live`), {
      function_arn: FUNCTION_ARN,
      function_name: 'suc1-aaaaaaaa-durable-caller',
      qualifier: 'live',
    });
    assert.equal(qualifiedFunctionParts(`${FUNCTION_ARN}:$LATEST`)?.qualifier, LATEST_VERSION);
  });

  it('reads nothing from an unqualified ARN or any other text', () => {
    assert.equal(qualifiedFunctionParts(FUNCTION_ARN), undefined);
    assert.equal(qualifiedFunctionParts('suc1-aaaaaaaa-durable-caller'), undefined);
    assert.equal(qualifiedFunctionParts(`${FUNCTION_ARN}:1:2`), undefined);
    assert.equal(qualifiedFunctionParts('arn:aws:sqs:us-east-1:1:function:f:1'), undefined);
  });
});

describe('functionReading', () => {
  it('reads the function name and ARN of GetFunction', () => {
    const output = { Configuration: { FunctionName: 'f', FunctionArn: FUNCTION_ARN }, Tags: {} };
    assert.deepEqual(functionReading(output), ok({ name: 'f', arn: FUNCTION_ARN }));
  });

  it('refuses a description without a name or an ARN', () => {
    assert.deepEqual(
      functionReading({}),
      malformed('GetFunction.Configuration', 'FunctionName is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      functionReading({ Configuration: { FunctionName: 'f' } }),
      malformed('GetFunction.Configuration', 'FunctionArn is absent; expected a non-empty string'),
    );
  });
});

describe('functionVersionsPage', () => {
  it('lists each published version by ARN, untaggable, without $LATEST, and pages by NextMarker', () => {
    const output = {
      Versions: [
        { FunctionArn: `${FUNCTION_ARN}:$LATEST`, Version: '$LATEST' },
        { FunctionArn: `${FUNCTION_ARN}:1`, Version: '1' },
      ],
      NextMarker: 'm',
    };
    assert.deepEqual(
      functionVersionsPage(output),
      ok({
        items: [
          {
            resource_type: FUNCTION_VERSION_RESOURCE_TYPE,
            identifier: `${FUNCTION_ARN}:1`,
            surface: 'functions',
            tags: { kind: 'untaggable' },
          },
        ],
        cursor: 'm',
      }),
    );
  });

  it('refuses a version without an ARN or a number', () => {
    assert.deepEqual(
      functionVersionsPage({ Versions: [{ Version: '1' }] }),
      malformed('ListVersionsByFunction.Versions[0]', 'FunctionArn is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      functionVersionsPage({ Versions: [{ FunctionArn: FUNCTION_ARN }] }),
      malformed('ListVersionsByFunction.Versions[0]', 'Version is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      functionVersionsPage({ Versions: 'x' }),
      malformed('ListVersionsByFunction', 'Versions is "x"; expected a list'),
    );
  });
});

describe('functionAliasesPage', () => {
  it('lists each alias by ARN, untaggable', () => {
    assert.deepEqual(
      functionAliasesPage({ Aliases: [{ AliasArn: `${FUNCTION_ARN}:live`, Name: 'live' }] }),
      ok({
        items: [
          {
            resource_type: FUNCTION_ALIAS_RESOURCE_TYPE,
            identifier: `${FUNCTION_ARN}:live`,
            surface: 'functions',
            tags: { kind: 'untaggable' },
          },
        ],
      }),
    );
    assert.deepEqual(functionAliasesPage({ NextMarker: 'n' }), ok({ items: [], cursor: 'n' }));
  });

  it('refuses an alias without an ARN', () => {
    assert.deepEqual(
      functionAliasesPage({ Aliases: [{ Name: 'live' }] }),
      malformed('ListAliases.Aliases[0]', 'AliasArn is absent; expected a non-empty string'),
    );
    assert.deepEqual(functionAliasesPage({ Aliases: 1 }), malformed('ListAliases', 'Aliases is 1; expected a list'));
  });
});

describe('mapping readings', () => {
  it('reads a mapping UUID, state and optional ARN', () => {
    assert.deepEqual(mappingReading({ UUID: 'u', State: 'Disabled' }), ok({ uuid: 'u', state: 'Disabled' }));
    assert.deepEqual(
      mappingReading({ UUID: 'u', State: 'Enabled', EventSourceMappingArn: 'arn:m' }),
      ok({ uuid: 'u', state: 'Enabled', arn: 'arn:m' }),
    );
  });

  it('refuses a mapping without a UUID, a state or a text ARN', () => {
    assert.deepEqual(
      mappingReading({ State: 'Enabled' }),
      malformed('GetEventSourceMapping', 'UUID is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      mappingReading({ UUID: 'u' }, 'At'),
      malformed('At', 'State is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      mappingReading({ UUID: 'u', State: 'Enabled', EventSourceMappingArn: 3 }),
      malformed('GetEventSourceMapping', 'EventSourceMappingArn is 3; expected a non-empty string'),
    );
  });

  it('pages a mapping listing by NextMarker', () => {
    assert.deepEqual(
      mappingsPage({ EventSourceMappings: [{ UUID: 'u', State: 'Enabled' }], NextMarker: 'm' }),
      ok({ items: [{ uuid: 'u', state: 'Enabled' }], cursor: 'm' }),
    );
    assert.deepEqual(
      mappingsPage({ EventSourceMappings: [{ UUID: 'u' }] }),
      malformed('ListEventSourceMappings.EventSourceMappings[0]', 'State is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      mappingsPage({ EventSourceMappings: {} }),
      malformed('ListEventSourceMappings', 'EventSourceMappings is a value of type object; expected a list'),
    );
  });
});

describe('durable execution readings', () => {
  const running = { DurableExecutionArn: EXECUTION_ARN, Status: 'RUNNING', StartTimestamp: new Date(0) };

  it('keeps RUNNING executions, untaggable, with their start time and the managing stack', () => {
    const output = { DurableExecutions: [running, { ...running, DurableExecutionArn: 'x', Status: 'SUCCEEDED' }] };
    assert.deepEqual(
      durableExecutionsPage({ ...output, NextMarker: 'm' }, STACK_ID),
      ok({
        items: [
          {
            resource_type: DURABLE_EXECUTION_RESOURCE_TYPE,
            identifier: EXECUTION_ARN,
            surface: 'durable_executions',
            tags: { kind: 'untaggable' },
            created_at: '1970-01-01T00:00:00.000Z',
            managed_by_stack_id: STACK_ID,
          },
        ],
        cursor: 'm',
      }),
    );
  });

  it('omits the stack when none is recorded and the start time when none is reported', () => {
    assert.deepEqual(
      durableExecutionsPage(
        { DurableExecutions: [{ DurableExecutionArn: EXECUTION_ARN, Status: 'RUNNING' }] },
        undefined,
      ),
      ok({
        items: [
          {
            resource_type: DURABLE_EXECUTION_RESOURCE_TYPE,
            identifier: EXECUTION_ARN,
            surface: 'durable_executions',
            tags: { kind: 'untaggable' },
          },
        ],
      }),
    );
  });

  it('refuses an execution without an ARN, a status or a valid start time', () => {
    const at = 'ListDurableExecutionsByFunction.DurableExecutions[0]';
    assert.deepEqual(
      durableExecutionsPage({ DurableExecutions: [{ Status: 'RUNNING' }] }, undefined),
      malformed(at, 'DurableExecutionArn is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      durableExecutionsPage({ DurableExecutions: [{ DurableExecutionArn: EXECUTION_ARN }] }, undefined),
      malformed(at, 'Status is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      durableExecutionsPage({ DurableExecutions: [{ ...running, StartTimestamp: 'today' }] }, undefined),
      malformed(at, 'StartTimestamp is "today"; expected a valid instant in years 0000-9999'),
    );
    assert.deepEqual(
      durableExecutionsPage({ DurableExecutions: null }, undefined),
      malformed('ListDurableExecutionsByFunction', 'DurableExecutions is null; expected a list'),
    );
  });

  it('reads the running ARNs of a page and the status of one execution', () => {
    assert.deepEqual(
      runningExecutionArnsPage({ DurableExecutions: [running], NextMarker: 'n' }),
      ok({ items: [EXECUTION_ARN], cursor: 'n' }),
    );
    assert.deepEqual(
      runningExecutionArnsPage({ DurableExecutions: [{}] }),
      malformed(
        'ListDurableExecutionsByFunction.DurableExecutions[0]',
        'DurableExecutionArn is absent; expected a non-empty string',
      ),
    );
    assert.deepEqual(durableStatusReading({ Status: 'STOPPED' }), ok('STOPPED'));
    assert.deepEqual(
      durableStatusReading({}),
      malformed('GetDurableExecution', 'Status is absent; expected a non-empty string'),
    );
  });
});
