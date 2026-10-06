// Read-only admission (BR-RUA-039..042, -017, -028, -046, -055; design §10.1, AC-RUA-014): steps
// A1..A15 in order, each recorded in the attempt journal before the next one runs, the first
// failing step ending the attempt with its rejection. Every port called before A15 reads; the
// only writes are the attempt's staging synthesis, its journal and rejection, and, once every
// check passed, the package draft whose manifest is written last. So a rejected attempt leaves
// no manifest, trial, result, summary, index or cloud mutation.

import type { AdmissionOutcome, AdmissionPorts, AdmissionRequest } from './admission-ports.ts';
import { AdmissionAttempt } from './admission-attempt.ts';
import { assessLocalInputs } from './admission-local-steps.ts';
import { assessAccountReadiness } from './admission-account-steps.ts';
import { freezeAdmittedExecution } from './admission-freeze-steps.ts';

/**
 * Admits one execution or rejects it with the first failing check.
 *
 * @example
 * const outcome = await admitExecution({ kind: 'TRANSPORT_PROBE', environment_input_path, financial_inputs }, ports);
 * if (outcome.kind === 'admitted') outcome.manifest_path; // 'transport-probes/<id>/admission/execution-manifest.json'
 */
export async function admitExecution(request: AdmissionRequest, ports: AdmissionPorts): Promise<AdmissionOutcome> {
  const attempt = new AdmissionAttempt(ports.ids.next(), request.kind, {
    journal: ports.journal,
    files: ports.files,
    clock: ports.clock,
    evidence_root: ports.paths.evidence_root,
  });
  const opened = await attempt.record('A1', {
    passed: true,
    value: null,
    statement: { subject: 'admission_attempt', expected: request.kind, observed: attempt.admission_attempt_id },
  });
  if (opened.kind === 'stop') {
    return opened.outcome;
  }
  const local = await assessLocalInputs(request, ports, attempt);
  if (local.kind === 'stop') {
    return local.outcome;
  }
  const account = await assessAccountReadiness(request, local.value, ports, attempt);
  if (account.kind === 'stop') {
    return account.outcome;
  }
  return freezeAdmittedExecution({ ...local.value, ...account.value }, ports, attempt);
}
