// Named fake of admission as the admit commands see it (design §12.2): it records every request
// and evidence root and answers one scripted outcome. Its conformance test binds the commands to
// the real `admitExecution` over the admission harness instead and expects the same reports.

import type { AdmissionOutcome, AdmissionRequest } from '../../../../src/admission/admission-ports.ts';

export interface AdmissionCall {
  readonly request: AdmissionRequest;
  readonly evidence_root: string;
}

export class ScriptedExecutionAdmitter {
  readonly #outcome: AdmissionOutcome;
  /** Every admission asked for, in order. */
  readonly calls: AdmissionCall[] = [];

  constructor(outcome: AdmissionOutcome) {
    this.#outcome = outcome;
  }

  /** The `ExecutionAdmitter` function bound to this fake. */
  readonly admit = (request: AdmissionRequest, evidenceRoot: string): Promise<AdmissionOutcome> => {
    this.calls.push({ request, evidence_root: evidenceRoot });
    return Promise.resolve(this.#outcome);
  };
}
