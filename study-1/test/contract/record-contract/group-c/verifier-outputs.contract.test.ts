// AC-RUA-046 (group C, rows 81-83, 87 and 88): the verifier outputs and the operator surface:
// probe usability, variant-validation verification, study completion, the oracle revision
// check and the CLI result line. Each case breaks one rule of a valid example.

import { describe, it } from 'node:test';

import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { CLI_EXIT_CODES, CLI_OUTCOMES } from '../../../../src/record-contract/records/group-c/vocabulary.ts';
import {
  assertAccepted,
  assertForbidden,
  assertRejected,
} from '../../../support/record-contract/group-b-validation.ts';
import { textOf, withValueAt } from '../../../support/record-contract/json-paths.ts';
import { PROBE_ID, RUN_ID, VALIDATION_ID, digest, toJson } from '../../../support/record-contract/record-builders.ts';
import {
  completedCliResult,
  failedRevisionCheck,
  passedRevisionCheck,
  usageErrorCliResult,
} from './examples/operator-examples.ts';
import { unusableProbe, usableProbe } from './examples/probe-examples.ts';
import {
  completeStudy,
  incompleteStudy,
  indeterminateValidationVerification,
  verifiedValidationVerification,
} from './examples/summary-examples.ts';
import { arrayAt, edited } from './support/json-edits.ts';

const REASONS: JsonValue = [{ code: 'VERIFIER_REASON', subject: 'verifier', detail: 'verifier states a reason' }];

describe('AC-RUA-046 probe_usability_assessment rules (BR-RUA-026, AC-RUA-056)', () => {
  const usable = toJson(usableProbe());
  const unusable = toJson(unusableProbe());

  it('usable only when every condition holds', () => {
    const unmet: readonly (readonly [string, JsonValue])[] = [
      ['transport_probe_verdict', 'fail'],
      ['probe_validity', 'indeterminate'],
      ['treatment_fidelity', 'unverified'],
      ['evidence_integrity', 'invalid'],
      ['late_evidence_status', 'contradictory'],
      ['late_evidence_status', 'unverified'],
      ['effective_cleanup_status', 'unverified'],
      ['effective_leak_audit_status', 'inconclusive'],
      ['effective_lease_status', 'recovery_required'],
      ['safety_status', 'breached'],
      ['package_eligibility', 'ineligible'],
    ];
    for (const [member, value] of unmet) {
      assertRejected(
        edited(usable, { [member]: value }),
        `usable with ${member} ${JSON.stringify(value)}`,
        `/${member}`,
      );
    }
    assertRejected(edited(usable, { transport_scope_snapshot_sha256: undefined }), 'no snapshot', ' required');
    assertRejected(edited(usable, { reasons: REASONS }), 'usable with reasons', '/reasons maxItems');
  });

  it('not_usable states each unmet condition by its code', () => {
    assertRejected(edited(unusable, { reasons: [] }), 'unexplained', '/reasons minItems');
    assertRejected(edited(unusable, { reasons: REASONS }), 'unknown code', '/reasons/0/code enum');
    assertAccepted(edited(unusable, { transport_scope_snapshot_sha256: undefined }), 'no snapshot when not usable');
  });

  it('assesses the probe only', () => {
    assertForbidden(edited(usable, { run_id: RUN_ID }), 'run identity', '/run_id');
    assertRejected(edited(usable, { transport_probe_id: undefined }), 'no probe', ' required');
  });
});

describe('AC-RUA-046 variant_validation_verification rules (CTR-RUA-004)', () => {
  const verified = toJson(verifiedValidationVerification());
  const indeterminate = toJson(indeterminateValidationVerification());

  it('a conclusive effective status needs an eligible, valid package with clean effective closure', () => {
    const unmet: readonly (readonly [string, JsonValue])[] = [
      ['package_eligibility', 'ineligible'],
      ['validation_validity', 'invalid'],
      ['effective_cleanup_status', 'partial'],
      ['effective_leak_audit_status', 'unverified'],
      ['effective_lease_status', 'recovery_required'],
    ];
    for (const [member, value] of unmet) {
      assertRejected(edited(verified, { [member]: value }), `verified with ${member}`, `/${member} const`);
      const failed = edited(verified, { effective_implementation_validation_status: 'failed', [member]: value });
      assertRejected(failed, `failed with ${member}`, `/${member} const`);
    }
  });

  it('recovery never turns one conclusive declared status into the other (BR-RUA-038, CTR-RUA-004)', () => {
    const crossings: readonly (readonly [string, string])[] = [
      ['failed', 'verified'],
      ['verified', 'failed'],
    ];
    for (const [declared, effective] of crossings) {
      assertRejected(
        edited(verified, {
          declared_implementation_validation_status: declared,
          effective_implementation_validation_status: effective,
        }),
        `declared ${declared}, effective ${effective}`,
        '/effective_implementation_validation_status enum',
      );
      assertAccepted(
        edited(verified, {
          declared_implementation_validation_status: declared,
          effective_implementation_validation_status: declared,
        }),
        `declared ${declared} kept`,
      );
      assertAccepted(
        edited(indeterminate, { declared_implementation_validation_status: declared }),
        `declared ${declared}, effective indeterminate`,
      );
    }
    // The verified example: recovery repaired the closure of a declared indeterminate validation.
    assertAccepted(verified, 'declared indeterminate, effective verified after recovery');
    assertAccepted(
      edited(verified, { effective_implementation_validation_status: 'failed' }),
      'declared indeterminate, effective failed after recovery',
    );
  });

  it('an indeterminate status states its reasons; no head means no recovery', () => {
    assertRejected(
      edited(indeterminate, { effective_status_reasons: [] }),
      'unexplained',
      '/effective_status_reasons minItems',
    );
    assertRejected(
      edited(indeterminate, { operational_recovery_applied: true }),
      'recovery without head',
      '/operational_recovery_applied const',
    );
    assertAccepted(edited(verified, { operational_recovery_applied: false }), 'a head without recovery');
  });

  it('names the summary across packages with its package-index digest (BR-RUA-035)', () => {
    assertRejected(
      withValueAt(verified, ['validation_summary_ref', 'package_index_sha256'], undefined),
      'local reference',
      '/validation_summary_ref required',
    );
    assertRejected(
      withValueAt(verified, ['validation_summary_ref', 'artifact_path'], '/abs.json'),
      'absolute path',
      '/validation_summary_ref/artifact_path format',
    );
  });

  it('has exactly the CTR-RUA-004 fields plus validation_validity', () => {
    assertRejected(edited(verified, { validation_validity: undefined }), 'no validity', ' required');
    assertRejected(
      edited(verified, { execution_manifest_sha256: digest('m') }),
      'manifest digest',
      ' additionalProperties',
    );
    assertForbidden(edited(verified, { run_id: RUN_ID }), 'run identity', '/run_id');
  });
});

describe('AC-RUA-046 study_completion_assessment rules (BR-RUA-054, AC-RUA-038)', () => {
  const complete = toJson(completeStudy());
  const incomplete = toJson(incompleteStudy());

  it('complete needs every original status and every check, and no reason', () => {
    const unmet: readonly (readonly [string, JsonValue])[] = [
      ['comparison_eligibility', 'ineligible'],
      ['package_eligibility', 'ineligible'],
      ['cleanup_status', 'partial'],
      ['leak_audit_status', 'inconclusive'],
      ['lease_status', 'unverified'],
      ['run_terminal_reason', 'TRIAL_INCOMPLETE'],
    ];
    for (const [member, value] of unmet) {
      assertRejected(edited(complete, { [member]: value }), `complete with ${member}`, `/${member} const`);
    }
    assertRejected(withValueAt(complete, ['checks', 6, 'holds'], false), 'a check fails', '/checks/6/holds const');
    assertRejected(
      edited(complete, { incompletion_reasons: REASONS }),
      'complete with reasons',
      '/incompletion_reasons maxItems',
    );
  });

  it('incomplete states its reasons; the seven checks keep their order', () => {
    const checks = arrayAt(complete, 'checks');
    assertRejected(edited(incomplete, { incompletion_reasons: [] }), 'unexplained', '/incompletion_reasons minItems');
    assertRejected(edited(complete, { checks: checks.toReversed() }), 'reversed checks', '/checks/0/check_id const');
    assertRejected(edited(complete, { checks: checks.slice(1) }), 'six checks', '/checks minItems');
  });

  it('assesses the original run package only', () => {
    assertForbidden(edited(complete, { variant_validation_id: VALIDATION_ID }), 'validation', '/variant_validation_id');
    assertRejected(
      edited(complete, { selected_amendment_head_sha256: null }),
      'amendment head',
      ' additionalProperties',
    );
  });
});

describe('AC-RUA-046 oracle_revision_check rules (BR-RUA-055, AC-RUA-055)', () => {
  const passed = toJson(passedRevisionCheck());
  const failed = toJson(failedRevisionCheck());

  it('passed needs exit 0, no failed, skipped or todo test, no uncovered pair and no reason', () => {
    assertRejected(edited(passed, { exit_code: 1 }), 'nonzero exit', '/exit_code const');
    for (const count of ['fail', 'skipped', 'todo']) {
      assertRejected(withValueAt(passed, ['test_counts', count], 1), `${count} test`, `/test_counts/${count} const`);
    }
    assertRejected(edited(passed, { uncovered: ['BR-RUA-001:pass'] }), 'uncovered pair', '/uncovered maxItems');
    assertRejected(edited(passed, { reasons: REASONS }), 'passed with reasons', '/reasons maxItems');
    assertRejected(edited(failed, { reasons: [] }), 'failed without reasons', '/reasons minItems');
  });

  it('identifies the commit, the toolchain and the coverage of each rule outcome', () => {
    assertAccepted(edited(passed, { commit_sha: digest('sha256-object-format') }), 'SHA-256 object format');
    assertRejected(
      edited(passed, { commit_sha: `${textOf(passed['commit_sha'] ?? null)}0` }),
      '41 hex',
      '/commit_sha pattern',
    );
    assertRejected(
      edited(passed, { tree_sha: textOf(passed['tree_sha'] ?? null).toUpperCase() }),
      'uppercase',
      '/tree_sha pattern',
    );
    assertRejected(edited(passed, { node_version: '24.15.0' }), 'no v prefix', '/node_version pattern');
    assertRejected(edited(passed, { exit_code: 256 }), 'exit 256', '/exit_code maximum');
    assertRejected(
      withValueAt(passed, ['rule_coverage', 0, 'case_ids'], []),
      'uncovered rule',
      '/rule_coverage/0/case_ids minItems',
    );
    assertRejected(
      withValueAt(passed, ['rule_coverage', 0, 'rule_id'], 'Rule-1'),
      'unknown rule',
      '/rule_coverage/0/rule_id pattern',
    );
    assertRejected(edited(failed, { uncovered: ['x', 'x'] }), 'duplicate pair', '/uncovered uniqueItems');
  });

  it('precedes the manifest, so it names an admission attempt and no execution', () => {
    assertForbidden(edited(passed, { run_id: RUN_ID }), 'run identity', '/run_id');
    assertForbidden(edited(passed, { transport_probe_id: PROBE_ID }), 'probe identity', '/transport_probe_id');
    assertRejected(
      edited(passed, { execution_manifest_sha256: digest('m') }),
      'manifest digest',
      ' additionalProperties',
    );
  });
});

describe('AC-RUA-046 cli_result rules (OQ-RUA-003, D-14)', () => {
  const completed = toJson(completedCliResult());
  const usage = toJson(usageErrorCliResult());

  it('each outcome has exactly one exit code (design §11)', () => {
    CLI_OUTCOMES.forEach((outcome, index) => {
      for (const [codeIndex, code] of CLI_EXIT_CODES.entries()) {
        const line = edited(usage, { outcome, exit_code: code });
        const label = `${outcome} exits ${String(code)}`;
        if (codeIndex === index) {
          assertAccepted(line, label);
        } else {
          assertRejected(line, label, '/exit_code const');
        }
      }
    });
    assertRejected(edited(usage, { exit_code: 1 }), 'unlisted exit code', '/exit_code enum');
  });

  it('every outcome but completed states its reasons', () => {
    assertRejected(edited(usage, { reasons: [] }), 'unexplained usage error', '/reasons minItems');
    assertAccepted(edited(completed, { reasons: REASONS }), 'completed with a note');
  });

  it('names at most one execution', () => {
    assertRejected(edited(completed, { transport_probe_id: PROBE_ID }), 'run and probe', ' not');
    assertRejected(
      edited(usage, { variant_validation_id: VALIDATION_ID, transport_probe_id: PROBE_ID }),
      'probe and validation',
      ' not',
    );
    assertAccepted(edited(usage, { variant_validation_id: VALIDATION_ID }), 'validation only');
  });

  it('lists unique package-relative written paths and carries the result record as JSON', () => {
    assertRejected(
      edited(completed, { written_paths: ['a.json', 'a.json'] }),
      'duplicate path',
      '/written_paths uniqueItems',
    );
    assertRejected(edited(completed, { written_paths: ['/tmp/a.json'] }), 'absolute path', '/written_paths/0 format');
    assertRejected(
      edited(completed, { result_record: { record_type: 'run_summary' } }),
      'unversioned record',
      '/result_record required',
    );
    assertRejected(edited(completed, { result_record: '{}' }), 'serialized record', '/result_record type');
    assertRejected(edited(completed, { command: 'Run' }), 'cased command', '/command pattern');
  });
});
