// The financial inputs and Region of one counted execution (close-out, the owner's item 3): read
// from the execution manifest, refused unless every trial's payment and approved decision state
// the same amounts and currency, then cross-checked with the spec's OR-RUA-001 fixture.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertFixtureInputs,
  deriveExecutionInputs,
  financialFixtureOf,
} from '../../../tools/lib/study-results-inputs.ts';
import type { EvidencePackage } from '../../../tools/lib/study-results-reading.ts';
import { loadPackage, readRecord } from '../../../tools/lib/study-results-reading.ts';
import { FINANCIAL_FIXTURE, RUN_DIRECTORY } from './support/execution-inputs.ts';
import type { EditableRecord, FileMap } from './support/in-memory-evidence.ts';
import {
  CONTROL_CONVENTIONAL,
  digestOf,
  editableIn,
  executionFiles,
  InMemoryEvidence,
  REGION,
  RUN_ID,
  TIMEOUT_DURABLE,
} from './support/in-memory-evidence.ts';

const MANIFEST = 'admission/execution-manifest.json';
const SUBJECT = `${RUN_DIRECTORY}/${MANIFEST}`;
const CONTROL_PAYMENT = `trials/${CONTROL_CONVENTIONAL.id}/inputs/payment.json`;
const CONTROL_DECISION = `trials/${CONTROL_CONVENTIONAL.id}/inputs/approved-decision.json`;
const TIMEOUT_PAYMENT = `trials/${TIMEOUT_DURABLE.id}/inputs/payment.json`;
const TIMEOUT_DECISION = `trials/${TIMEOUT_DURABLE.id}/inputs/approved-decision.json`;

/** A two-trial run package, its files edited first, and the files it was built from. */
function runPackage(edit: (files: FileMap) => void = () => undefined): { pkg: EvidencePackage; files: FileMap } {
  const files = executionFiles('run', RUN_ID, [CONTROL_CONVENTIONAL, TIMEOUT_DURABLE]);
  edit(files);
  const evidence = new InMemoryEvidence();
  evidence.putPackage(RUN_DIRECTORY, files);
  return { pkg: loadPackage(RUN_DIRECTORY, evidence.read), files };
}

/** An edit of one JSON object file of a package. */
function editing(path: string, change: (record: EditableRecord) => void): (files: FileMap) => void {
  return (files) => {
    const record = editableIn(files, path);
    change(record);
    files.set(path, record);
  };
}

function inputsOf(edit?: (files: FileMap) => void): ReturnType<typeof deriveExecutionInputs> {
  const { pkg } = runPackage(edit);
  return deriveExecutionInputs(pkg, readRecord(pkg, MANIFEST), [CONTROL_CONVENTIONAL.id, TIMEOUT_DURABLE.id]);
}

const FIXTURE_TABLE = [
  '### OR-RUA-001 — Financial fixture',
  '',
  '| Field | Value |',
  '|---|---:|',
  '| `currency` | `BRL` |',
  '| `captured_amount_minor` | `10000` |',
  '| `approved_amount_minor` | `10000` |',
];

describe('deriveExecutionInputs', () => {
  it("states the manifest's amounts, currency and Region, citing the manifest and every trial input in path order", () => {
    const { pkg, files } = runPackage();
    const manifest = readRecord(pkg, MANIFEST);
    // The trial ids in reverse order, so that only the sort puts the references in path order.
    const inputs = deriveExecutionInputs(pkg, manifest, [TIMEOUT_DURABLE.id, CONTROL_CONVENTIONAL.id]);
    const ref = (path: string): Record<string, string> => ({
      package_index_sha256: pkg.index_sha256,
      artifact_path: path,
      artifact_sha256: digestOf(files.get(path) ?? ''),
    });
    assert.deepEqual(inputs, {
      ...FINANCIAL_FIXTURE,
      region: REGION,
      evidence_refs: [MANIFEST, CONTROL_DECISION, CONTROL_PAYMENT, TIMEOUT_DECISION, TIMEOUT_PAYMENT].map(ref),
    });
  });

  it('reads the approved amount from the approved decision and the captured amount from the payment', () => {
    const inputs = inputsOf((files) => {
      editing(MANIFEST, (manifest) => {
        manifest['financial_inputs'] = { approved_amount_minor: 4000, captured_amount_minor: 10000, currency: 'BRL' };
      })(files);
      editing(CONTROL_DECISION, (decision) => {
        decision['approved_amount_minor'] = 4000;
      })(files);
      editing(TIMEOUT_DECISION, (decision) => {
        decision['approved_amount_minor'] = 4000;
      })(files);
    });
    assert.deepEqual([inputs.approved_amount_minor, inputs.captured_amount_minor], ['4000', '10000']);
  });

  it("refuses a trial payment or approved decision that differs from the manifest's amount or currency", () => {
    assert.throws(
      () =>
        inputsOf(
          editing(TIMEOUT_PAYMENT, (payment) => {
            payment['captured_amount_minor'] = 9999;
          }),
        ),
      {
        message:
          `${RUN_DIRECTORY}/${TIMEOUT_PAYMENT}: captured_amount_minor and currency are 9999 BRL; ` +
          "expected the manifest's 10000 BRL",
      },
    );
    assert.throws(
      () =>
        inputsOf(
          editing(CONTROL_DECISION, (decision) => {
            decision['currency'] = 'USD';
          }),
        ),
      {
        message:
          `${RUN_DIRECTORY}/${CONTROL_DECISION}: approved_amount_minor and currency are 10000 USD; ` +
          "expected the manifest's 10000 BRL",
      },
    );
  });

  it("refuses a manifest whose safety Region differs from its environment's", () => {
    assert.throws(
      () =>
        inputsOf(
          editing(MANIFEST, (manifest) => {
            manifest['safety'] = { region: 'eu-west-1' };
          }),
        ),
      { message: `${SUBJECT}: safety.region is eu-west-1; expected environment.region ${REGION}` },
    );
  });

  it('names the manifest member that is absent or of another type', () => {
    const refusal = (change: (manifest: EditableRecord) => void): string => {
      try {
        inputsOf(editing(MANIFEST, change));
      } catch (error) {
        return (error as Error).message;
      }
      return 'no refusal';
    };
    assert.deepEqual(
      [
        refusal((manifest) => {
          manifest['financial_inputs'] = {
            approved_amount_minor: '10000',
            captured_amount_minor: 10000,
            currency: 'BRL',
          };
        }),
        refusal((manifest) => {
          manifest['financial_inputs'] = { approved_amount_minor: 10000, captured_amount_minor: 1.5, currency: 'BRL' };
        }),
        refusal((manifest) => {
          manifest['financial_inputs'] = { approved_amount_minor: 10000, captured_amount_minor: 10000 };
        }),
        refusal((manifest) => {
          manifest['environment'] = {};
        }),
        refusal((manifest) => {
          manifest['safety'] = {};
        }),
      ],
      [
        `${SUBJECT} financial_inputs: approved_amount_minor is string "10000"; expected a safe integer`,
        `${SUBJECT} financial_inputs: captured_amount_minor is number 1.5; expected a safe integer`,
        `${SUBJECT} financial_inputs: currency is absent; expected a string`,
        `${SUBJECT} environment: region is absent; expected a string`,
        `${SUBJECT} safety: region is absent; expected a string`,
      ],
    );
  });
});

describe('financialFixtureOf', () => {
  it('reads the three fields of the OR-RUA-001 table', () => {
    assert.deepEqual(
      financialFixtureOf(['# CAP-RUA', '', ...FIXTURE_TABLE, '', '## Next'].join('\n')),
      FINANCIAL_FIXTURE,
    );
  });

  it('ignores rows under any other heading, including one that only starts with OR-RUA-001', () => {
    const spec = [
      '### OR-RUA-0010 — Another table',
      '| `currency` | `USD` |',
      ...FIXTURE_TABLE,
      '### OR-RUA-002 — Next table',
      '| `approved_amount_minor` | `1` |',
    ].join('\n');
    assert.deepEqual(financialFixtureOf(spec), FINANCIAL_FIXTURE);
  });

  it('ignores rows before the first heading', () => {
    assert.deepEqual(financialFixtureOf(['| `currency` | `USD` |', ...FIXTURE_TABLE].join('\n')), FINANCIAL_FIXTURE);
  });

  it('refuses a field with no row or with two rows in the table', () => {
    assert.throws(() => financialFixtureOf(FIXTURE_TABLE.slice(0, -1).join('\n')), {
      message:
        'the spec holds 0 OR-RUA-001 rows for approved_amount_minor; expected one "| `approved_amount_minor` | `<value>` |" row',
    });
    assert.throws(() => financialFixtureOf([...FIXTURE_TABLE, '| `currency` | `USD` |'].join('\n')), {
      message: 'the spec holds 2 OR-RUA-001 rows for currency; expected one "| `currency` | `<value>` |" row',
    });
  });

  it('refuses a table row that is not exactly two code cells', () => {
    for (const row of ['| `currency` | BRL |', ' | `currency` | `BRL` |', '| `currency` | `BRL` | x |']) {
      const spec = [...FIXTURE_TABLE.filter((line) => !line.includes('`currency`')), row].join('\n');
      assert.throws(() => financialFixtureOf(spec), /holds 0 OR-RUA-001 rows for currency/, row);
    }
  });
});

describe('assertFixtureInputs', () => {
  it('accepts inputs equal to the fixture', () => {
    assert.doesNotThrow(() => {
      assertFixtureInputs(FINANCIAL_FIXTURE, FINANCIAL_FIXTURE, 'runs/x');
    });
  });

  it('names every field that differs from the fixture, in field order', () => {
    const stated = { approved_amount_minor: '1', captured_amount_minor: '10000', currency: 'USD' };
    assert.throws(
      () => {
        assertFixtureInputs(stated, FINANCIAL_FIXTURE, 'runs/x');
      },
      {
        message:
          "runs/x states approved_amount_minor 1, currency USD; expected OR-RUA-001's approved_amount_minor 10000, currency BRL",
      },
    );
    assert.throws(
      () => {
        assertFixtureInputs({ ...FINANCIAL_FIXTURE, captured_amount_minor: '2' }, FINANCIAL_FIXTURE, 'runs/x');
      },
      { message: "runs/x states captured_amount_minor 2; expected OR-RUA-001's captured_amount_minor 10000" },
    );
  });
});
