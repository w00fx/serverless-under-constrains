// AWS bindings of admission's read ports (design §10.1 A6-A8, §9.1): `sts:GetCallerIdentity`,
// `lambda:GetAccountSettings`, `cloudformation:DescribeStacks CDKToolkit`, and DynamoDB
// `DescribeTable` plus `DescribeTimeToLive` of the coordination table. Every call is a read; no
// mutating command is imported here. Thin by construction: one request per port call, the raw
// output handed to the pure mappers in `cloud-readings.ts`. Clients are built with
// `maxAttempts: 1` and the study Region, so a retry never hides a failure and no other Region is
// ever read.

import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import type { CloudFormationClientConfig } from '@aws-sdk/client-cloudformation';
import { DescribeTableCommand, DescribeTimeToLiveCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { GetAccountSettingsCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { LambdaClientConfig } from '@aws-sdk/client-lambda';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { STSClientConfig } from '@aws-sdk/client-sts';

import { nonEmptyString, ownValue } from '../../evidence-collection/sdk-values.ts';
import { err, ok } from '../../record-contract/primitives.ts';
import type { Result } from '../../record-contract/primitives.ts';
import type {
  AccountSettingsReadPort,
  BootstrapStackReadPort,
  CallerIdentity,
  CallerIdentityPort,
  CoordinationTableDescription,
  CoordinationTableReadPort,
  PortFailure,
  PortResult,
} from '../admission-ports.ts';
import {
  BOOTSTRAP_STACK_NAME,
  bootstrapStatusOf,
  callerIdentityOf,
  coordinationTableOf,
  isMissingStackError,
  unreservedConcurrencyOf,
} from '../cloud-readings.ts';

export const ADMISSION_CLIENT_OPTIONS = { region: 'us-east-1', maxAttempts: 1 } as const;
const PINNED_SETTING_NAMES: ReadonlySet<string> = new Set(['region', 'maxAttempts', 'retryStrategy', 'retryMode']);

/** Client settings a caller may supply (tests: a scripted `requestHandler` and static credentials). */
export type AdmissionClientSettings = Omit<STSClientConfig, 'region' | 'maxAttempts' | 'retryStrategy' | 'retryMode'> &
  Omit<LambdaClientConfig, 'region' | 'maxAttempts' | 'retryStrategy' | 'retryMode'> &
  Omit<CloudFormationClientConfig, 'region' | 'maxAttempts' | 'retryStrategy' | 'retryMode'> &
  Omit<DynamoDBClientConfig, 'region' | 'maxAttempts' | 'retryStrategy' | 'retryMode'>;

/** The four read-only clients of admission. */
export interface AdmissionClients {
  readonly sts: STSClient;
  readonly lambda: LambdaClient;
  readonly cloudformation: CloudFormationClient;
  readonly dynamodb: DynamoDBClient;
}

/**
 * Builds admission's clients; production passes nothing.
 *
 * @example
 * const clients = createAdmissionClients();
 */
export function createAdmissionClients(settings: AdmissionClientSettings = {}): AdmissionClients {
  // A cast can smuggle a pinned key past the type, so pinned keys are dropped at run time too.
  const allowed = Object.fromEntries(Object.entries(settings).filter(([name]) => !PINNED_SETTING_NAMES.has(name)));
  const config = { ...allowed, ...ADMISSION_CLIENT_OPTIONS };
  return {
    sts: new STSClient(config),
    lambda: new LambdaClient(config),
    cloudformation: new CloudFormationClient(config),
    dynamodb: new DynamoDBClient(config),
  };
}

/**
 * The caller-identity port over STS.
 *
 * @example
 * await createCallerIdentityReader(clients.sts).readCallerIdentity();
 */
export function createCallerIdentityReader(client: STSClient): CallerIdentityPort {
  return {
    readCallerIdentity: async (): PortResult<CallerIdentity> => {
      const output = await settle(() => client.send(new GetCallerIdentityCommand({})));
      if (!output.ok) {
        return output;
      }
      const region = await settle(() => client.config.region());
      return region.ok ? callerIdentityOf(output.value, region.value) : region;
    },
  };
}

/**
 * The account-settings port over Lambda.
 *
 * @example
 * await createAccountSettingsReader(clients.lambda).readUnreservedConcurrency();
 */
export function createAccountSettingsReader(client: LambdaClient): AccountSettingsReadPort {
  return {
    readUnreservedConcurrency: async (): PortResult<number> => {
      const output = await settle(() => client.send(new GetAccountSettingsCommand({})));
      return output.ok ? unreservedConcurrencyOf(output.value) : output;
    },
  };
}

/**
 * The bootstrap-stack port over CloudFormation; a missing stack reads `undefined`.
 *
 * @example
 * await createBootstrapStackReader(clients.cloudformation).readBootstrapStackStatus();
 */
export function createBootstrapStackReader(client: CloudFormationClient): BootstrapStackReadPort {
  return {
    readBootstrapStackStatus: async (): PortResult<string | undefined> => {
      const output = await settle(() => client.send(new DescribeStacksCommand({ StackName: BOOTSTRAP_STACK_NAME })));
      if (output.ok) {
        return bootstrapStatusOf(output.value);
      }
      return isMissingStackError(output.error.code, output.error.detail) ? ok(undefined) : output;
    },
  };
}

/**
 * The coordination-table port over DynamoDB: DescribeTable, then DescribeTimeToLive.
 *
 * @example
 * await createCoordinationTableReader(clients.dynamodb).readCoordinationTable(tableArn);
 */
export function createCoordinationTableReader(client: DynamoDBClient): CoordinationTableReadPort {
  return {
    readCoordinationTable: async (tableArn: string): PortResult<CoordinationTableDescription> => {
      const table = await settle(() => client.send(new DescribeTableCommand({ TableName: tableArn })));
      if (!table.ok) {
        return table;
      }
      const ttl = await settle(() => client.send(new DescribeTimeToLiveCommand({ TableName: tableArn })));
      return ttl.ok ? coordinationTableOf(table.value, ttl.value) : ttl;
    },
  };
}

async function settle<T>(call: () => Promise<T>): Promise<Result<T, PortFailure>> {
  try {
    return ok(await call());
  } catch (error: unknown) {
    // An Error's name lives on its prototype unless the SDK set its own (service exceptions do).
    const name = error instanceof Error ? error.name : ownValue(error, 'name');
    const message = error instanceof Error ? error.message : ownValue(error, 'message');
    return err({ code: nonEmptyString(name) ?? 'UnknownError', detail: nonEmptyString(message) ?? 'no message' });
  }
}
