// The canonical run's verdicts re-derived from the public redacted copy (close-out Phase 3): the
// ledger rules BR-RUA-001, BR-RUA-002 and BR-RUA-009 recomputed from the redacted ledger and trial
// inputs, refused unless each equals the original oracle result.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { recheckRunVerdicts } from '../../../tools/lib/redacted-verdicts.ts';
import { loadPackage } from '../../../tools/lib/study-results-reading.ts';
import type { FileContent } from './support/in-memory-evidence.ts';
import { bytesOf, digestOf, editableIn, InMemoryEvidence } from './support/in-memory-evidence.ts';
import type { LedgerTransaction, LedgerTrial } from './support/redaction-evidence.ts';
import {
  AUTHORIZED,
  DOUBLE_REFUND,
  ledgerTrialFiles,
  PASSING,
  redactedReader,
  RUN,
  runPackageFiles,
} from './support/redaction-evidence.ts';

const TRIAL = `${RUN}/trials/${PASSING.id}`;
const ORACLE = `${TRIAL}/derived/oracle-result.json`;

function evidenceWith(
  trials: readonly LedgerTrial[],
  edit?: (files: Map<string, FileContent>) => void,
): InMemoryEvidence {
  const files = runPackageFiles(trials);
  edit?.(files);
  const evidence = new InMemoryEvidence();
  evidence.putPackage(RUN, files);
  return evidence;
}

function recheck(
  evidence: InMemoryEvidence,
  overrides?: ReadonlyMap<string, Uint8Array | undefined>,
): ReturnType<typeof recheckRunVerdicts> {
  return recheckRunVerdicts(loadPackage(RUN, evidence.read), redactedReader(evidence, overrides));
}

function trialOf(transactions: readonly LedgerTransaction[], expected: string): LedgerTrial {
  const [first, second, third] = expected.split(' ');
  return {
    id: PASSING.id,
    transactions,
    rules: { 'BR-RUA-001': first ?? '', 'BR-RUA-002': second ?? '', 'BR-RUA-009': third ?? '' },
    verdict: expected === 'pass pass pass' ? 'pass' : 'fail',
  };
}

describe('recheckRunVerdicts', () => {
  it("states each trial's ledger rules and verdict beside the oracle's, with both ledger digests", () => {
    const ledger = ledgerTrialFiles(PASSING).get(`trials/${PASSING.id}/ledger/ledger-snapshot.json`) ?? {};
    // A redacted ledger may differ in bytes and still decide the same rules.
    const reformatted = new TextEncoder().encode(JSON.stringify(ledger, null, 1));
    const rechecks = recheck(
      evidenceWith([PASSING, DOUBLE_REFUND]),
      new Map([[`${TRIAL}/ledger/ledger-snapshot.json`, reformatted]]),
    );
    const rules = (result: string): unknown[] =>
      ['BR-RUA-001', 'BR-RUA-002', 'BR-RUA-009'].map((rule_id) => ({
        rule_id,
        redacted_ledger: result,
        oracle_result: result,
      }));
    assert.deepEqual(rechecks, [
      {
        trial_id: PASSING.id,
        scenario: 'CONTROL',
        variant_id: 'durable',
        ledger_path: `${TRIAL}/ledger/ledger-snapshot.json`,
        original_ledger_sha256: digestOf(ledger),
        redacted_ledger_sha256: digestOf(JSON.stringify(ledger, null, 1)),
        rules: rules('pass'),
        preservation_verdict: { redacted_ledger: 'pass', oracle_result: 'pass' },
      },
      {
        trial_id: DOUBLE_REFUND.id,
        scenario: 'CONTROL',
        variant_id: 'durable',
        ledger_path: `${RUN}/trials/${DOUBLE_REFUND.id}/ledger/ledger-snapshot.json`,
        original_ledger_sha256: digestOf({ complete: true, transactions: DOUBLE_REFUND.transactions }),
        redacted_ledger_sha256: digestOf({ complete: true, transactions: DOUBLE_REFUND.transactions }),
        rules: rules('fail'),
        preservation_verdict: { redacted_ledger: 'fail', oracle_result: 'fail' },
      },
    ]);
  });

  it('decides each ledger rule from the SUCCEEDED transactions alone', () => {
    const other = { ...AUTHORIZED, refund_request_id: 'ref-2', payment_id: 'pay-2', amount_minor: 500 };
    const cases: readonly (readonly [readonly LedgerTransaction[], string])[] = [
      [[AUTHORIZED, { ...AUTHORIZED, status: 'FAILED' }], 'pass pass pass'],
      [[AUTHORIZED, AUTHORIZED], 'fail fail fail'],
      [[], 'fail pass fail'],
      [[{ ...AUTHORIZED, amount_minor: 9000 }], 'pass pass fail'],
      [[{ ...AUTHORIZED, amount_minor: 10001 }], 'pass fail fail'],
      [[{ ...AUTHORIZED, currency: 'USD' }], 'pass pass fail'],
      [[{ ...AUTHORIZED, payment_id: 'pay-2' }], 'pass pass fail'],
      [[{ ...AUTHORIZED, refund_request_id: 'ref-2' }], 'fail pass fail'],
      [[AUTHORIZED, other], 'pass pass fail'],
      [
        [
          { ...AUTHORIZED, amount_minor: 4000 },
          { ...AUTHORIZED, refund_request_id: 'ref-2', amount_minor: 6000 },
        ],
        'pass pass fail',
      ],
      [
        [
          { ...AUTHORIZED, amount_minor: 4000 },
          { ...AUTHORIZED, refund_request_id: 'ref-2', amount_minor: 6001 },
        ],
        'pass fail fail',
      ],
    ];
    for (const [transactions, expected] of cases) {
      const [only] = recheck(evidenceWith([trialOf(transactions, expected)]));
      assert.deepEqual(
        [...(only?.rules.map((rule) => rule.redacted_ledger) ?? []), only?.preservation_verdict.redacted_ledger],
        [...expected.split(' '), expected === 'pass pass pass' ? 'pass' : 'fail'],
        JSON.stringify(transactions),
      );
    }
  });

  it('reads only trial oracle results, never another file named like one', () => {
    const evidence = evidenceWith([PASSING], (files) => {
      for (const decoy of [
        'late/trials/x/derived/oracle-result.json',
        `trials/${PASSING.id}/derived/oracle-result.json.bak`,
        `trials/${PASSING.id}/nested/derived/oracle-result.json`,
        'trials//derived/oracle-result.json',
      ]) {
        files.set(decoy, {});
      }
    });
    assert.deepEqual(
      recheck(evidence).map((one) => one.trial_id),
      [PASSING.id],
    );
  });

  it('refuses a ledger rule or verdict that differs from the oracle result, naming each difference', () => {
    assert.throws(() => recheck(evidenceWith([{ ...PASSING, rules: { ...PASSING.rules, 'BR-RUA-002': 'fail' } }])), {
      message: `${ORACLE}: the redacted ledger gives BR-RUA-002 pass where the oracle has fail; expected the oracle's results`,
    });
    assert.throws(
      () => recheck(evidenceWith([{ ...PASSING, rules: { ...PASSING.rules, 'BR-RUA-001': 'fail' }, verdict: 'fail' }])),
      {
        message:
          `${ORACLE}: the redacted ledger gives BR-RUA-001 pass where the oracle has fail; ` +
          "preservation_verdict pass where the oracle has fail; expected the oracle's results",
      },
    );
    const withoutRule = evidenceWith([PASSING], (files) => {
      const oracle = editableIn(files, `trials/${PASSING.id}/derived/oracle-result.json`);
      oracle['rule_results'] = [
        { rule_id: 'BR-RUA-001', result: 'pass' },
        { rule_id: 'BR-RUA-002', result: 'pass' },
      ];
      files.set(`trials/${PASSING.id}/derived/oracle-result.json`, oracle);
    });
    assert.throws(() => recheck(withoutRule), {
      message: `${ORACLE}: the redacted ledger gives BR-RUA-009 pass where the oracle has absent; expected the oracle's results`,
    });
  });

  it('refuses a trial that is not valid, an incomplete ledger and a copy without the ledger', () => {
    assert.throws(() => recheck(evidenceWith([{ ...PASSING, validity: 'indeterminate' }])), {
      message: `${ORACLE}: trial_validity is indeterminate; expected valid, the only trial a ledger verdict decides`,
    });
    assert.throws(() => recheck(evidenceWith([{ ...PASSING, complete: false }])), {
      message: `redacted ${TRIAL}/ledger/ledger-snapshot.json: complete is false; expected a complete ledger snapshot`,
    });
    assert.throws(() => recheck(evidenceWith([PASSING]), new Map([[`${TRIAL}/inputs/payment.json`, undefined]])), {
      message: `the redacted copy holds no ${TRIAL}/inputs/payment.json; expected every file of the original package`,
    });
  });

  it('names the original trial manifest when it lacks the scenario', () => {
    const evidence = evidenceWith([PASSING], (files) => {
      const manifest = editableIn(files, `trials/${PASSING.id}/trial-manifest.json`);
      manifest['scenario'] = undefined;
      files.set(`trials/${PASSING.id}/trial-manifest.json`, manifest);
    });
    assert.throws(
      () => recheck(evidence),
      (error: Error) => error.message.startsWith(`${TRIAL}/trial-manifest.json: scenario `),
    );
  });

  it('names the redacted file whose member is malformed', () => {
    const missing = (path: string, member: string): Map<string, Uint8Array> => {
      const files = ledgerTrialFiles(PASSING);
      const record = editableIn(files, `trials/${PASSING.id}/${path}`);
      record[member] = undefined;
      return new Map([[`${TRIAL}/${path}`, bytesOf(record)]]);
    };
    for (const [path, member] of [
      ['ledger/ledger-snapshot.json', 'transactions'],
      ['inputs/payment.json', 'captured_amount_minor'],
      ['inputs/approved-decision.json', 'currency'],
    ] as const) {
      assert.throws(
        () => recheck(evidenceWith([PASSING]), missing(path, member)),
        (error: Error) => error.message.startsWith(`redacted ${TRIAL}/${path}: `) && error.message.includes(member),
        `${path} ${member}`,
      );
    }
  });
});
