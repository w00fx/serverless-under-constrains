// The exit mapping of `probe|validation|run execute` and of `recover` (design §11 exit codes;
// BR-RUA-019, BR-RUA-044, BR-RUA-045, BR-RUA-048): the most severe outcome wins, in the order
// unfinalized package (10), lease (7), operational closure (6), incomplete workload (4), and only a
// finalized package with every declared unit frozen uninterrupted and a clean closure completes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ExecutionOutcome } from '../../../src/execution-lifecycle/execution-ports.ts';
import { closureVerdict, executionReport } from '../../../src/operator-cli/execution-exit.ts';
import type { Sha256Hex, Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { SettlementAssessment } from '../../../src/settlement/settlement-policy.ts';
import type {
  ProbeExecutionReport,
  TrialExecutionReport,
  TrialInterruption,
} from '../../../src/trial-execution/trial-execution-ports.ts';
import { goldenAdmitted } from './support/golden-admitted.ts';

const RUN = goldenAdmitted('run');
const PROBE = goldenAdmitted('probe');
const SETTLEMENT = { settlement_status: 'indeterminate' } as unknown as SettlementAssessment;
const ABORT: TrialInterruption = { cause: 'OPERATOR_ABORT', detail: 'SIGINT' };
const RUNNER_REASON = { code: 'RUNNER_NOTE', subject: 'BR-RUA-044', detail: 'from the runner' };

function frozenTrial(index: number, interruption?: TrialInterruption): TrialExecutionReport {
  return {
    kind: 'frozen',
    trial_id: `00000000-0000-4000-8000-00000000000${String(index)}` as Uuid4,
    settlement: SETTLEMENT,
    ...(interruption === undefined ? {} : { interruption }),
    evidence_index_path: `trials/${String(index)}/evidence-index.json`,
    evidence_index_sha256: 'a'.repeat(64) as Sha256Hex,
    failures: [],
  };
}

function frozenProbe(interruption?: TrialInterruption): ProbeExecutionReport {
  return {
    kind: 'frozen',
    transport_probe_id: '00000000-0000-4000-8000-0000000000aa' as Uuid4,
    settlement: SETTLEMENT,
    ...(interruption === undefined ? {} : { interruption }),
    evidence_index_path: 'probe/evidence-index.json',
    evidence_index_sha256: 'b'.repeat(64) as Sha256Hex,
    failures: [],
  };
}

const ALL_FROZEN = RUN.manifest.trials.map((_trial, index) => frozenTrial(index + 1));

function cleanRun(overrides: Partial<ExecutionOutcome> = {}): ExecutionOutcome {
  return {
    package_finalized: true,
    trials: ALL_FROZEN,
    cleanup_status: 'succeeded',
    leak_audit_status: 'clean',
    lease_status: 'released',
    reasons: [RUNNER_REASON],
    ...overrides,
  };
}

function codesOf(outcome: ExecutionOutcome, admitted = RUN): readonly string[] {
  return executionReport(admitted, outcome).reasons.map((reason) => reason.code);
}

describe('executionReport', () => {
  it('completes a clean run with every declared trial frozen and names the package index', () => {
    assert.equal(RUN.manifest.trials.length, 4, 'the golden run declares four trials');
    const report = executionReport(RUN, cleanRun());
    assert.deepEqual(report, {
      outcome: 'completed',
      execution: RUN.identity,
      written_paths: [`${RUN.package_directory}/package-index.json`],
      reasons: [RUNNER_REASON],
    });
  });

  it('completes a probe whose one unit froze, and counts a missing probe as unfrozen', () => {
    const probe = cleanRun({ trials: [], probe: frozenProbe() });
    assert.equal(executionReport(PROBE, probe).outcome, 'completed');
    const missing = executionReport(PROBE, cleanRun({ trials: [] }));
    assert.equal(missing.outcome, 'execution_incomplete');
    assert.equal(
      missing.reasons.at(-1)?.detail,
      '0 of 1 declared units froze uninterrupted, interruption none; expected every declared unit frozen without interruption',
    );
  });

  it('reports an unfinalized package as an internal failure with no written path, whatever else happened', () => {
    const report = executionReport(RUN, cleanRun({ package_finalized: false, lease_status: 'unverified' }));
    assert.equal(report.outcome, 'internal_failure');
    assert.deepEqual(report.written_paths, []);
    assert.deepEqual(report.reasons.at(-1), {
      code: 'PACKAGE_NOT_FINALIZED',
      subject: 'BR-RUA-044',
      detail: `${RUN.package_directory} was not finalized; expected package-index.json written last`,
    });
  });

  it('reports a lease never held, without an interruption, as a lease problem', () => {
    const { cleanup_status: _c, leak_audit_status: _a, ...unheld } = cleanRun({ trials: [], lease_status: 'released' });
    const report = executionReport(RUN, unheld);
    assert.equal(report.outcome, 'lease_problem');
    assert.deepEqual(report.reasons.at(-1), {
      code: 'LEASE_NOT_ACQUIRED',
      subject: 'BR-RUA-045',
      detail:
        "the coordination lease was not held (lease released; the runner journal's LEASE_ACQUISITION event names why); expected it acquired before the first deployment",
    });
    const { lease_status: _l, ...noLease } = unheld;
    assert.match(executionReport(RUN, noLease).reasons.at(-1)?.detail ?? '', /\(lease undefined; /);
  });

  it('treats an interrupted execution that never held the lease as incomplete, not as a lease problem', () => {
    const { cleanup_status: _c, leak_audit_status: _a, ...unheld } = cleanRun({ trials: [], interruption: ABORT });
    assert.deepEqual(codesOf(unheld), ['RUNNER_NOTE', 'EXECUTION_INCOMPLETE']);
  });

  it('treats a lease left recovery_required as held but not clean', () => {
    const { cleanup_status: _c, leak_audit_status: _a, ...marked } = cleanRun({ lease_status: 'recovery_required' });
    const report = executionReport(RUN, marked);
    assert.equal(report.outcome, 'operational_closure_not_clean');
    assert.deepEqual(report.reasons.at(-1), {
      code: 'OPERATIONAL_CLOSURE_NOT_CLEAN',
      subject: 'BR-RUA-048',
      detail:
        'cleanup undefined, leak audit undefined, lease recovery_required; expected cleanup succeeded, audit clean and lease released',
    });
  });

  it('ranks an unverified lease above an unclean closure and an incomplete workload', () => {
    const report = executionReport(
      RUN,
      cleanRun({ lease_status: 'unverified', cleanup_status: 'failed', trials: [], interruption: ABORT }),
    );
    assert.equal(report.outcome, 'lease_problem');
    assert.deepEqual(report.reasons.at(-1), {
      code: 'LEASE_UNVERIFIED',
      subject: 'BR-RUA-045',
      detail: 'the lease is unverified; expected released',
    });
  });

  it('ranks an unclean cleanup or audit above an incomplete workload', () => {
    assert.equal(
      executionReport(RUN, cleanRun({ cleanup_status: 'failed', trials: [] })).outcome,
      'operational_closure_not_clean',
    );
    assert.equal(
      executionReport(RUN, cleanRun({ leak_audit_status: 'inconclusive', interruption: ABORT })).outcome,
      'operational_closure_not_clean',
    );
  });

  it('reports an interruption, an interrupted unit or an unfrozen unit as incomplete', () => {
    const interrupted = executionReport(RUN, cleanRun({ interruption: ABORT }));
    assert.equal(interrupted.outcome, 'execution_incomplete');
    assert.deepEqual(interrupted.reasons.at(-1), {
      code: 'EXECUTION_INCOMPLETE',
      subject: 'BR-RUA-019',
      detail:
        '4 of 4 declared units froze uninterrupted, interruption OPERATOR_ABORT (SIGINT); expected every declared unit frozen without interruption',
    });
    const unitInterrupted = cleanRun({ trials: [...ALL_FROZEN.slice(0, 3), frozenTrial(4, ABORT)] });
    assert.match(executionReport(RUN, unitInterrupted).reasons.at(-1)?.detail ?? '', /^3 of 4 declared units/);
    const notStarted: TrialExecutionReport = {
      kind: 'not_started',
      trial_id: '00000000-0000-4000-8000-000000000004' as Uuid4,
      reasons: [],
    };
    assert.match(
      executionReport(RUN, cleanRun({ trials: [...ALL_FROZEN.slice(0, 3), notStarted] })).reasons.at(-1)?.detail ?? '',
      /^3 of 4 declared units/,
    );
    assert.equal(
      executionReport(PROBE, cleanRun({ trials: [], probe: frozenProbe(ABORT) })).outcome,
      'execution_incomplete',
    );
  });
});

describe('closureVerdict', () => {
  it('completes a clean, released closure and one that names no cleanup', () => {
    assert.deepEqual(
      closureVerdict({ cleanup_status: 'succeeded', leak_audit_status: 'clean', lease_status: 'released' }),
      {
        outcome: 'completed',
      },
    );
    assert.deepEqual(closureVerdict({ leak_audit_status: 'inconclusive' }), { outcome: 'completed' });
  });

  it('is not clean for a failed cleanup, an inconclusive audit or a lease left for recovery', () => {
    const cases = [
      { cleanup_status: 'failed', leak_audit_status: 'clean', lease_status: 'released' },
      { cleanup_status: 'succeeded', leak_audit_status: 'inconclusive', lease_status: 'released' },
      { cleanup_status: 'succeeded', leak_audit_status: 'clean', lease_status: 'recovery_required' },
    ] as const;
    for (const closure of cases) {
      assert.equal(closureVerdict(closure).outcome, 'operational_closure_not_clean', JSON.stringify(closure));
    }
  });

  it('is a lease problem when the lease is unverified, even when cleanup is clean', () => {
    const verdict = closureVerdict({
      cleanup_status: 'succeeded',
      leak_audit_status: 'clean',
      lease_status: 'unverified',
    });
    assert.equal(verdict.outcome, 'lease_problem');
    assert.equal(verdict.reason?.code, 'LEASE_UNVERIFIED');
  });
});
