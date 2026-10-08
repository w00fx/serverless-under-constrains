// Admission step A2: the operator's environment input (BR-RUA-041, design §10.1). The exact file
// bytes are parsed and validated against the closed `environment_input` schema, which admits no
// credential, token, password or credential-process field. The coordination table ARN and the
// coordination stack id must then belong to the single allowlisted account (ACCOUNT) and to the
// committed Region `us-east-1` (REGION). The caller account itself is resolved later (A7).

import { sha256Hex } from '../record-contract/digests.ts';
import { boundedText } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonValue, Result, Sha256Hex, StructuredReason } from '../record-contract/primitives.ts';
import type { EnvironmentInput } from '../record-contract/records/group-a/environment_input.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { SAFETY_REGION } from '../safety/safety-limits.ts';
import { admissionReason } from './admission-reason.ts';
import { failed, passed } from './preflight-check.ts';
import type { CheckStatement, StepVerdict } from './preflight-check.ts';

const SUBJECT = 'BR-RUA-041';
const VIOLATIONS_QUOTED = 3;

/** The validated environment input, its exact bytes and their digest. */
export interface AdmittedEnvironmentInput {
  readonly input: EnvironmentInput;
  readonly bytes: Uint8Array;
  readonly sha256: Sha256Hex;
  /** The single allowlisted 12-digit account. */
  readonly account_id: string;
}

/**
 * Validates parsed environment input against its closed schema.
 *
 * @example
 * const input = validateEnvironmentInput(JSON.parse(text), validator);
 * if (input.ok) input.value.account_allowlist[0]; // '012345678901'
 */
export function validateEnvironmentInput(
  raw: JsonValue,
  validator: RecordValidator,
): Result<EnvironmentInput, readonly [StructuredReason, ...StructuredReason[]]> {
  const validation = validator.validateAs('environment_input', raw);
  if (validation.valid) {
    return ok(validation.record as EnvironmentInput);
  }
  const summary = admissionReason(
    'ENVIRONMENT_INPUT_INVALID',
    SUBJECT,
    `environment input has ${String(validation.violations.length)} schema violation(s); expected a closed, ` +
      'credential-free environment_input record',
  );
  const quoted = validation.violations
    .slice(0, VIOLATIONS_QUOTED)
    .map((violation) =>
      admissionReason(
        'ENVIRONMENT_INPUT_INVALID',
        SUBJECT,
        `environment input at ${boundedText(violation.instance_path === '' ? '/' : violation.instance_path)} ` +
          `violates ${violation.keyword}: ${violation.detail}`,
      ),
    );
  return err([summary, ...quoted]);
}

/**
 * Step A2 over the exact bytes of the environment input file.
 *
 * @example
 * const verdict = assessEnvironmentInput(bytes, validator);
 * if (verdict.passed) verdict.value.account_id; // '012345678901'
 */
export function assessEnvironmentInput(
  bytes: Uint8Array,
  validator: RecordValidator,
): StepVerdict<AdmittedEnvironmentInput> {
  const sha256 = sha256Hex(bytes);
  const statement: CheckStatement = { subject: 'environment_input', expected: 'environment_input', observed: sha256 };
  const parsed = parseJsonDocument(bytes);
  if (!parsed.ok) {
    return failed('ACCOUNT', statement, [
      admissionReason(
        'ENVIRONMENT_INPUT_UNREADABLE',
        SUBJECT,
        `environment input is not UTF-8 JSON (${parsed.error.kind}); expected one environment_input JSON document`,
      ),
    ]);
  }
  const validated = validateEnvironmentInput(parsed.value, validator);
  if (!validated.ok) {
    return failed('ACCOUNT', statement, validated.error);
  }
  return placementVerdict({ input: validated.value, bytes, sha256, account_id: validated.value.account_allowlist[0] });
}

// The coordination ARNs are `arn:aws:<service>:<region>:<account>:<resource>`; the schema has
// already proven that shape, so fields 3 and 4 are the Region and the account.
function placementVerdict(admitted: AdmittedEnvironmentInput): StepVerdict<AdmittedEnvironmentInput> {
  const arns = [
    { name: 'coordination_table_arn', arn: admitted.input.coordination_table_arn },
    { name: 'coordination_stack_id', arn: admitted.input.coordination_stack_id },
  ];
  const statement: CheckStatement = {
    subject: 'coordination_placement',
    expected: { account: admitted.account_id, region: SAFETY_REGION },
    observed: Object.fromEntries(arns.map(({ name, arn }) => [name, arn])),
  };
  const foreignAccount = arns.filter(({ arn }) => arnField(arn, 4) !== admitted.account_id);
  const [accountReason, ...accountReasons] = foreignAccount.map(({ name, arn }) =>
    admissionReason(
      'COORDINATION_NOT_IN_ACCOUNT',
      SUBJECT,
      `${name} ${boundedText(arn)} names account ${arnField(arn, 4)}; expected the allowlisted account ${admitted.account_id}`,
    ),
  );
  if (accountReason !== undefined) {
    return failed('ACCOUNT', statement, [accountReason, ...accountReasons]);
  }
  const foreignRegion = arns.filter(({ arn }) => arnField(arn, 3) !== SAFETY_REGION);
  const [regionReason, ...regionReasons] = foreignRegion.map(({ name, arn }) =>
    admissionReason(
      'COORDINATION_NOT_IN_REGION',
      SUBJECT,
      `${name} ${boundedText(arn)} names Region ${arnField(arn, 3)}; expected ${SAFETY_REGION}`,
    ),
  );
  if (regionReason !== undefined) {
    return failed('REGION', statement, [regionReason, ...regionReasons]);
  }
  return passed(admitted, statement);
}

function arnField(arn: string, index: number): string {
  return String(arn.split(':')[index]);
}
