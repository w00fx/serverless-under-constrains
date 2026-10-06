// Total mappers from AWS read outputs to admission's port values (A-05; design §15.4: decisions
// stay outside `aws/`, so they are mutation targets). The outputs are untrusted: a member may be
// absent, of the wrong type, inherited or non-finite, and each mapper turns that into a
// `PortFailure` naming the member and the expected shape, never into a guess or a throw. The
// adapters in `aws/` send exactly one read per call and hand the raw output here.

import { nonEmptyString, ownValue, quoted } from '../evidence-collection/sdk-values.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result } from '../record-contract/primitives.ts';
import type {
  CallerIdentity,
  CoordinationKeyAttribute,
  CoordinationTableDescription,
  PortFailure,
} from './admission-ports.ts';

/** The `CDKToolkit` stack name the CDK bootstrap creates. */
export const BOOTSTRAP_STACK_NAME = 'CDKToolkit';

/**
 * `sts:GetCallerIdentity` output plus the client's configured Region.
 *
 * @example
 * callerIdentityOf({ Account: '012345678901', Arn: 'arn:aws:iam::012345678901:user/x' }, 'us-east-1');
 */
export function callerIdentityOf(output: unknown, region: unknown): Result<CallerIdentity, PortFailure> {
  const account = nonEmptyString(ownValue(output, 'Account'));
  const arn = nonEmptyString(ownValue(output, 'Arn'));
  const configured = nonEmptyString(region);
  if (account === undefined || arn === undefined || configured === undefined) {
    return err(
      malformed(
        'GetCallerIdentity',
        `Account ${quoted(ownValue(output, 'Account'))}, Arn ${quoted(ownValue(output, 'Arn'))} and Region ${quoted(region)}; expected three nonempty strings`,
      ),
    );
  }
  return ok({ account, arn, region: configured });
}

/**
 * `lambda:GetAccountSettings` `AccountLimit.UnreservedConcurrentExecutions`.
 *
 * @example
 * unreservedConcurrencyOf({ AccountLimit: { UnreservedConcurrentExecutions: 1000 } }); // { ok: true, value: 1000 }
 */
export function unreservedConcurrencyOf(output: unknown): Result<number, PortFailure> {
  const value = ownValue(ownValue(output, 'AccountLimit'), 'UnreservedConcurrentExecutions');
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return err(
      malformed(
        'GetAccountSettings',
        `UnreservedConcurrentExecutions is ${quoted(value)}; expected a nonnegative safe integer`,
      ),
    );
  }
  return ok(value);
}

/**
 * `DescribeStacks CDKToolkit`: the stack's status.
 *
 * @example
 * bootstrapStatusOf({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] }); // { ok: true, value: 'UPDATE_COMPLETE' }
 */
export function bootstrapStatusOf(output: unknown): Result<string | undefined, PortFailure> {
  const stacks = ownValue(output, 'Stacks');
  if (!Array.isArray(stacks) || stacks.length !== 1) {
    return err(
      malformed('DescribeStacks', `Stacks is ${quoted(stacks)}; expected exactly one ${BOOTSTRAP_STACK_NAME} stack`),
    );
  }
  const status = nonEmptyString(ownValue(stacks[0], 'StackStatus'));
  return status === undefined
    ? err(
        malformed('DescribeStacks', `StackStatus is ${quoted(ownValue(stacks[0], 'StackStatus'))}; expected a status`),
      )
    : ok(status);
}

/**
 * Whether a DescribeStacks failure means the bootstrap stack does not exist (CloudFormation
 * answers `ValidationError` "Stack with id CDKToolkit does not exist"), which is an answer, not
 * a failed read.
 *
 * @example
 * isMissingStackError('ValidationError', 'Stack with id CDKToolkit does not exist'); // true
 */
export function isMissingStackError(name: string, message: string): boolean {
  return name === 'ValidationError' && message.includes(`${BOOTSTRAP_STACK_NAME} does not exist`);
}

/**
 * `DescribeTable` and `DescribeTimeToLive` outputs of the coordination table.
 *
 * @example
 * coordinationTableOf(describeTableOutput, describeTimeToLiveOutput); // { ok: true, value: { table_status: 'ACTIVE', … } }
 */
export function coordinationTableOf(
  table: unknown,
  timeToLive: unknown,
): Result<CoordinationTableDescription, PortFailure> {
  const described = ownValue(table, 'Table');
  const arn = nonEmptyString(ownValue(described, 'TableArn'));
  const status = nonEmptyString(ownValue(described, 'TableStatus'));
  const keys = keySchemaOf(ownValue(described, 'KeySchema'), ownValue(described, 'AttributeDefinitions'));
  const ttlStatus = ownValue(ownValue(timeToLive, 'TimeToLiveDescription'), 'TimeToLiveStatus');
  const ttl = nonEmptyString(ttlStatus);
  if (arn === undefined || status === undefined || keys === undefined || ttl === undefined) {
    return err(
      malformed(
        'DescribeTable',
        `TableArn ${quoted(ownValue(described, 'TableArn'))}, TableStatus ${quoted(ownValue(described, 'TableStatus'))}, ` +
          `KeySchema ${quoted(ownValue(described, 'KeySchema'))} and TimeToLiveStatus ${quoted(ttlStatus)}; expected all four`,
      ),
    );
  }
  return ok({
    table_arn: arn,
    table_status: status,
    key_schema: keys,
    deletion_protection_enabled: ownValue(described, 'DeletionProtectionEnabled') === true,
    time_to_live_status: ttl,
  });
}

function keySchemaOf(keySchema: unknown, definitions: unknown): readonly CoordinationKeyAttribute[] | undefined {
  if (!Array.isArray(keySchema)) {
    return undefined;
  }
  const types = new Map<string, string>();
  for (const definition of Array.isArray(definitions) ? definitions : []) {
    const name = nonEmptyString(ownValue(definition, 'AttributeName'));
    const type = nonEmptyString(ownValue(definition, 'AttributeType'));
    if (name !== undefined && type !== undefined) {
      types.set(name, type);
    }
  }
  const keys = keySchema.map((key: unknown) => keyAttributeOf(key, types));
  return keys.every((key) => key !== undefined) ? keys : undefined;
}

function keyAttributeOf(key: unknown, types: ReadonlyMap<string, string>): CoordinationKeyAttribute | undefined {
  const name = nonEmptyString(ownValue(key, 'AttributeName'));
  const keyType = nonEmptyString(ownValue(key, 'KeyType'));
  if (name === undefined || keyType === undefined) {
    return undefined;
  }
  const type = types.get(name);
  return type === undefined
    ? { attribute_name: name, key_type: keyType }
    : { attribute_name: name, key_type: keyType, attribute_type: type };
}

function malformed(operation: string, detail: string): PortFailure {
  return { code: `${operation}OutputMalformed`, detail };
}
