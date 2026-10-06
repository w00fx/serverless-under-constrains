// Admission steps A2..A5 (design §10.1): what the operator and the work tree supply, judged before
// any account is read. A2 reads the environment input file's exact bytes, A3 and A4 judge the
// financial and identity input, A5 judges the committed source.

import type { Result } from '../record-contract/primitives.ts';
import type { FileSystemFailure } from '../evidence-package/package-file-system.ts';
import type { AdmissionPorts, AdmissionRequest, GitSourceState, PortFailure } from './admission-ports.ts';
import type { AdmissionAttempt, StepContinuation } from './admission-attempt.ts';
import { portFailureReason } from './admission-reason.ts';
import { assessEnvironmentInput } from './environment-input.ts';
import type { AdmittedEnvironmentInput } from './environment-input.ts';
import { assessFinancialInput, assessIdentityInput } from './financial-input.ts';
import type { AdmittedRequestInputs } from './financial-input.ts';
import { failed } from './preflight-check.ts';
import type { StepVerdict } from './preflight-check.ts';
import { assessSourceProvenance } from './source-provenance.ts';
import type { AdmittedSource } from './source-provenance.ts';

/** What A2..A5 admit. */
export interface LocalInputs {
  readonly environment: AdmittedEnvironmentInput;
  readonly inputs: AdmittedRequestInputs;
  readonly source: AdmittedSource;
}

/**
 * Steps A2..A5, each recorded before the next runs.
 *
 * @example
 * const local = await assessLocalInputs(request, ports, attempt);
 * if (local.kind === 'continue') local.value.source.commit_sha;
 */
export async function assessLocalInputs(
  request: AdmissionRequest,
  ports: AdmissionPorts,
  attempt: AdmissionAttempt,
): Promise<StepContinuation<LocalInputs>> {
  const environmentBytes = await ports.files.read(request.environment_input_path);
  const environment = await attempt.record('A2', environmentVerdict(environmentBytes, ports));
  if (environment.kind === 'stop') {
    return environment;
  }
  const objects = await attempt.record('A3', assessFinancialInput(request.financial_inputs));
  if (objects.kind === 'stop') {
    return objects;
  }
  const inputs = await attempt.record('A4', assessIdentityInput(objects.value, request.kind, request.variant));
  if (inputs.kind === 'stop') {
    return inputs;
  }
  const source = await attempt.record('A5', sourceVerdict(await ports.git.readGitSourceState()));
  if (source.kind === 'stop') {
    return source;
  }
  return { kind: 'continue', value: { environment: environment.value, inputs: inputs.value, source: source.value } };
}

function environmentVerdict(
  bytes: Result<Uint8Array, FileSystemFailure>,
  ports: AdmissionPorts,
): StepVerdict<AdmittedEnvironmentInput> {
  if (bytes.ok) {
    return assessEnvironmentInput(bytes.value, ports.validator);
  }
  return failed('ACCOUNT', { subject: 'environment_input', expected: 'environment_input' }, [
    portFailureReason('ENVIRONMENT_INPUT_UNREADABLE', 'BR-RUA-041', 'the environment input file read', bytes.error),
  ]);
}

function sourceVerdict(state: Result<GitSourceState, PortFailure>): StepVerdict<AdmittedSource> {
  if (state.ok) {
    return assessSourceProvenance(state.value);
  }
  return failed('SOURCE_PROVENANCE', { subject: 'source_provenance', expected: 'clean_committed_source' }, [
    portFailureReason('GIT_STATE_UNREADABLE', 'BR-RUA-042', 'the git source state read', state.error),
  ]);
}
