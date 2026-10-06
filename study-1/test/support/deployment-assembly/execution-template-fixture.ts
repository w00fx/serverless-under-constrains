// A compact execution template with the shape `infra/stacks/execution-stack.ts` synthesizes for a
// canonical run (design §9.2-9.5): the construct paths, resource types and the properties the
// deployment readers use, with short logical ids. The integration tests read the real synthesized
// template; this fixture keeps unit tests fast and lets them change one property at a time.

import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';

export const STACK = 'SucRua-run-3f1c2a9e';
const encoder = new TextEncoder();

/** Logical ids of the fixture's resources. */
export const FIXTURE_IDS = {
  providerFunction: 'ProviderFunction',
  providerVersion: 'ProviderVersion1',
  controllerFunction: 'ControllerFunction',
  controllerMapping: 'ControllerMapping',
  callerJournalTable: 'CallerJournalTable',
  controllerFailure: 'ControllerFailure',
  conventionalCaller: 'ConventionalCaller',
  conventionalAlias: 'ConventionalAlias',
  conventionalSource: 'ConventionalSource',
  conventionalDeadLetter: 'ConventionalDlq',
  conventionalMapping: 'ConventionalMapping',
  durableCaller: 'DurableCaller',
  durableAlias: 'DurableAlias',
  durableSource: 'DurableSource',
  durableDeadLetter: 'DurableDlq',
  durableMapping: 'DurableMapping',
} as const;

function resource(type: string, path: string, properties: JsonObject): JsonObject {
  return { Type: type, Properties: properties, Metadata: { 'aws:cdk:path': `${STACK}/${path}` } };
}

function lambdaFunction(timeout: number, variables: JsonObject, extra: JsonObject = {}): JsonObject {
  return {
    Runtime: 'nodejs24.x',
    Architectures: ['x86_64'],
    MemorySize: 512,
    Timeout: timeout,
    Environment: { Variables: variables },
    ...extra,
  };
}

function aliasTarget(aliasId: string): JsonValue {
  return { 'Fn::Join': ['', [{ 'Fn::Select': [6, { 'Fn::Split': [':', { Ref: aliasId }] }] }, ':live']] };
}

function variantResources(construct: string, ids: VariantIds, visibility: number, durable: boolean): JsonObject {
  const callerExtra: JsonObject = durable ? { DurableConfig: { ExecutionTimeout: 300, RetentionPeriodInDays: 1 } } : {};
  return {
    [ids.caller]: resource(
      'AWS::Lambda::Function',
      `${construct}/Caller/Function/Resource`,
      lambdaFunction(
        10,
        {
          SUC_PROVIDER_FUNCTION_NAME: { Ref: FIXTURE_IDS.providerFunction },
          SUC_PROVIDER_QUALIFIER: { 'Fn::GetAtt': [FIXTURE_IDS.providerVersion, 'Version'] },
          SUC_VARIANT_ID: construct === 'DurableVariant' ? 'durable' : 'conventional',
        },
        callerExtra,
      ),
    ),
    [ids.alias]: resource('AWS::Lambda::Alias', `${construct}/Caller/Function/Aliaslive/Resource`, {
      FunctionName: { Ref: ids.caller },
      Name: 'live',
    }),
    [ids.source]: resource('AWS::SQS::Queue', `${construct}/Source/Queue/Resource`, {
      FifoQueue: true,
      ContentBasedDeduplication: false,
      VisibilityTimeout: visibility,
      RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': [ids.deadLetter, 'Arn'] }, maxReceiveCount: 2 },
    }),
    [ids.deadLetter]: resource('AWS::SQS::Queue', `${construct}/Source/DeadLetterQueue/Resource`, { FifoQueue: true }),
    [ids.mapping]: resource(
      'AWS::Lambda::EventSourceMapping',
      `${construct}/Caller/Function/Aliaslive/SqsEventSource:SucRuarun3f1c2a9e${construct}SourceQueue12AB/Resource`,
      { BatchSize: 1, EventSourceArn: { 'Fn::GetAtt': [ids.source, 'Arn'] }, FunctionName: aliasTarget(ids.alias) },
    ),
  };
}

interface VariantIds {
  readonly caller: string;
  readonly alias: string;
  readonly source: string;
  readonly deadLetter: string;
  readonly mapping: string;
}

/**
 * A fresh run template object; tests may change it freely.
 *
 * @example
 * const template = runTemplate();
 * delete resourceAt(template, FIXTURE_IDS.conventionalMapping)['Properties'];
 */
export function runTemplate(): JsonObject {
  const ids = FIXTURE_IDS;
  return {
    Resources: {
      [ids.callerJournalTable]: resource('AWS::DynamoDB::Table', 'ExperimentCore/CallerJournalTable/Resource', {
        StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
      }),
      [ids.providerFunction]: resource(
        'AWS::Lambda::Function',
        'ExperimentCore/Provider/Function/Resource',
        lambdaFunction(30, { SUC_TABLE_LEDGER: 'suc1-3f1c2a9e-ledger', SUC_EXECUTION_ID: 'x' }),
      ),
      [ids.providerVersion]: resource(
        'AWS::Lambda::Version',
        'ExperimentCore/Provider/Function/CurrentVersion/Resource',
        {
          FunctionName: { Ref: ids.providerFunction },
        },
      ),
      [ids.controllerFunction]: resource(
        'AWS::Lambda::Function',
        'ExperimentCore/Controller/Function/Resource',
        lambdaFunction(30, { SUC_EXECUTION_ID: 'x' }),
      ),
      [ids.controllerFailure]: resource('AWS::SQS::Queue', 'ExperimentCore/ControllerFailure/Resource', {}),
      [ids.controllerMapping]: resource(
        'AWS::Lambda::EventSourceMapping',
        'ExperimentCore/Controller/Function/CallerJournalStream/Resource',
        {
          FunctionName: { Ref: ids.controllerFunction },
          StartingPosition: 'TRIM_HORIZON',
          BatchSize: 1,
          MaximumBatchingWindowInSeconds: 0,
          ParallelizationFactor: 1,
          MaximumRetryAttempts: 2,
          MaximumRecordAgeInSeconds: 3600,
          BisectBatchOnFunctionError: false,
          FilterCriteria: { Filters: [{ Pattern: '{"eventName":["INSERT"]}' }] },
          DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': [ids.controllerFailure, 'Arn'] } } },
        },
      ),
      ...variantResources(
        'ConventionalVariant',
        {
          caller: ids.conventionalCaller,
          alias: ids.conventionalAlias,
          source: ids.conventionalSource,
          deadLetter: ids.conventionalDeadLetter,
          mapping: ids.conventionalMapping,
        },
        60,
        false,
      ),
      ...variantResources(
        'DurableVariant',
        {
          caller: ids.durableCaller,
          alias: ids.durableAlias,
          source: ids.durableSource,
          deadLetter: ids.durableDeadLetter,
          mapping: ids.durableMapping,
        },
        360,
        true,
      ),
    },
  };
}

/**
 * The mutable resource object with `logicalId` in a fixture template; throws when absent.
 *
 * @example
 * resourceAt(template, FIXTURE_IDS.providerVersion)['Type'] = 'AWS::Lambda::Alias';
 */
export function resourceAt(template: JsonObject, logicalId: string): Record<string, JsonValue> {
  const resources = template['Resources'] as Record<string, Record<string, JsonValue>>;
  const found = resources[logicalId];
  if (found === undefined) {
    throw new Error(`fixture has no resource ${JSON.stringify(logicalId)}; expected one of FIXTURE_IDS`);
  }
  return found;
}

/**
 * The mutable `Properties` of a fixture resource.
 *
 * @example
 * propertiesAt(template, FIXTURE_IDS.conventionalMapping)['BatchSize'] = 10;
 */
export function propertiesAt(template: JsonObject, logicalId: string): Record<string, JsonValue> {
  return resourceAt(template, logicalId)['Properties'] as Record<string, JsonValue>;
}

/** Removes a resource from a fixture template. */
export function removeResource(template: JsonObject, logicalId: string): void {
  resourceAt(template, logicalId);
  Reflect.deleteProperty(template['Resources'] as Record<string, JsonValue>, logicalId);
}

/** UTF-8 JSON bytes of a template object. */
export function templateBytes(template: JsonObject): Uint8Array {
  return encoder.encode(JSON.stringify(template));
}
