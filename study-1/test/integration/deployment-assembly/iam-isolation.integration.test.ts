// The IAM matrix of every execution stack (design §9.6; BR-RUA-018; RK-15; AC-RUA-053 supplementary).
// The synthesized policies of each role are read back as "actions -> target" lines, where a target
// is the construct path of the resource a statement names, and asserted exactly for a run, a
// transport probe and a validation of each variant. No role has a managed or inline policy, every
// statement allows without a condition, only stream listing uses `*`, and no caller role reaches
// the ledger, the control table or the experiment journal, which keeps provider events, commits,
// signals and treatment state out of variant reach.
//
// Two lines differ from the §9.6 table and are the synthesized behavior of WP-20/WP-21, pinned
// here: the variant callers also `Query` their own caller journal, and the Durable caller's
// checkpoint rights are an explicit policy on its own function versions, not the managed
// `AWSLambdaBasicDurableExecutionRolePolicy`.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { synthContext } from '../../support/deployment-assembly/deployment-fixtures.ts';
import { synthesizeExecution } from '../../support/deployment-assembly/study-synth.ts';
import type { SynthesizedExecution } from '../../support/deployment-assembly/study-synth.ts';

const LOGS = 'logs:CreateLogStream,logs:PutLogEvents';
const CALLER_JOURNAL = 'ExperimentCore/CallerJournalTable';
const FORBIDDEN_TO_CALLERS = [
  'ExperimentCore/LedgerTable',
  'ExperimentCore/ControlTable',
  'ExperimentCore/ExperimentJournalTable',
];

const PROVIDER_MATRIX = [
  'dynamodb:ConditionCheckItem,dynamodb:GetItem,dynamodb:UpdateItem -> ExperimentCore/ControlTable',
  'dynamodb:PutItem -> ExperimentCore/ExperimentJournalTable',
  'dynamodb:PutItem -> ExperimentCore/LedgerTable',
  `${LOGS} -> ExperimentCore/Provider/LogGroup`,
];
const CONTROLLER_MATRIX = [
  `dynamodb:DescribeStream,dynamodb:GetRecords,dynamodb:GetShardIterator -> ${CALLER_JOURNAL}#StreamArn`,
  'dynamodb:GetItem,dynamodb:UpdateItem -> ExperimentCore/ControlTable',
  'dynamodb:ListStreams -> *',
  'dynamodb:PutItem -> ExperimentCore/ExperimentJournalTable',
  `${LOGS} -> ExperimentCore/Controller/LogGroup`,
  'sqs:GetQueueAttributes,sqs:GetQueueUrl,sqs:SendMessage -> ExperimentCore/ControllerFailure',
];

function variantMatrix(construct: string): readonly string[] {
  const shared = [
    `dynamodb:ConditionCheckItem,dynamodb:GetItem,dynamodb:PutItem,dynamodb:Query,dynamodb:UpdateItem -> ${CALLER_JOURNAL}`,
    'dynamodb:GetItem -> ExperimentCore/TrialRegistryTable',
    'lambda:InvokeFunction -> ExperimentCore/Provider/Function/CurrentVersion',
    `${LOGS} -> ${construct}/Caller/LogGroup`,
    `sqs:ChangeMessageVisibility,sqs:DeleteMessage,sqs:GetQueueAttributes,sqs:GetQueueUrl,sqs:ReceiveMessage -> ${construct}/Source/Queue`,
  ];
  const durable =
    construct === 'DurableVariant'
      ? ['lambda:CheckpointDurableExecution,lambda:GetDurableExecutionState -> DurableVariant/Caller/Function:*']
      : [];
  return [...shared, ...durable].toSorted();
}

const PROBE_MATRIX = [
  `dynamodb:ConditionCheckItem,dynamodb:GetItem,dynamodb:PutItem,dynamodb:UpdateItem -> ${CALLER_JOURNAL}`,
  'lambda:InvokeFunction -> ExperimentCore/Provider/Function/CurrentVersion',
  `${LOGS} -> ProbeCaller/Caller/LogGroup`,
];

interface StatementJson {
  readonly Effect: string;
  readonly Action: JsonValue;
  readonly Resource: JsonValue;
  readonly Condition?: JsonValue;
}

let workDir = '';
const executions = new Map<string, SynthesizedExecution>();

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'rua-iam-'));
  executions.set('run', synthesizeExecution(synthContext('RUN'), join(workDir, 'run')));
  executions.set('probe', synthesizeExecution(synthContext('TRANSPORT_PROBE'), join(workDir, 'probe')));
  executions.set(
    'conventional',
    synthesizeExecution(synthContext('VARIANT_VALIDATION', 'conventional'), join(workDir, 'conventional')),
  );
  executions.set(
    'durable',
    synthesizeExecution(synthContext('VARIANT_VALIDATION', 'durable'), join(workDir, 'durable')),
  );
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function execution(name: string): SynthesizedExecution {
  const found = executions.get(name);
  assert.ok(found !== undefined, `${name} was synthesized`);
  return found;
}

function resources(synthesized: SynthesizedExecution): Readonly<Record<string, JsonObject>> {
  return synthesized.json['Resources'] as Readonly<Record<string, JsonObject>>;
}

// The construct path below the stack, without the trailing `/Resource`.
function constructOf(synthesized: SynthesizedExecution, logicalId: string): string {
  const path = (resources(synthesized)[logicalId]?.['Metadata'] as JsonObject | undefined)?.['aws:cdk:path'];
  assert.ok(typeof path === 'string', `${logicalId} has a construct path`);
  return path.split('/').slice(1, -1).join('/');
}

function targetOf(synthesized: SynthesizedExecution, resource: JsonValue): string {
  const text = JSON.stringify(resource);
  const getAtt = /^\{"Fn::GetAtt":\["([A-Za-z0-9]+)","(Arn|StreamArn)"\]\}$/.exec(text);
  const ref = /^\{"Ref":"([A-Za-z0-9]+)"\}$/.exec(text);
  const versions = /^\{"Fn::Join":\["",\[\{"Fn::GetAtt":\["([A-Za-z0-9]+)","Arn"\]\},":\*"\]\]\}$/.exec(text);
  if (getAtt?.[1] !== undefined) {
    return `${constructOf(synthesized, getAtt[1])}${getAtt[2] === 'StreamArn' ? '#StreamArn' : ''}`;
  }
  if (ref?.[1] !== undefined) {
    return constructOf(synthesized, ref[1]);
  }
  if (versions?.[1] !== undefined) {
    return `${constructOf(synthesized, versions[1])}:*`;
  }
  assert.equal(resource, '*', `statement resource ${text} is a known shape`);
  return '*';
}

function asList(value: JsonValue): readonly JsonValue[] {
  return Array.isArray(value) ? (value as readonly JsonValue[]) : [value];
}

function refOf(role: JsonObject): string {
  const ref = role['Ref'];
  assert.ok(typeof ref === 'string', `role ${JSON.stringify(role)} is a Ref`);
  return ref;
}

// The "actions -> target" lines of one policy statement, which allows without a condition.
function statementLines(synthesized: SynthesizedExecution, statement: StatementJson): readonly string[] {
  assert.deepEqual([statement.Effect, statement.Condition], ['Allow', undefined]);
  const actions = asList(statement.Action).map(String).toSorted().join(',');
  return asList(statement.Resource).map((resource) => `${actions} -> ${targetOf(synthesized, resource)}`);
}

/** Every role of the stack, by construct path, with its sorted "actions -> target" lines. */
function roleMatrix(synthesized: SynthesizedExecution): ReadonlyMap<string, readonly string[]> {
  const matrix = new Map<string, string[]>();
  for (const [id, found] of Object.entries(resources(synthesized))) {
    if (found['Type'] === 'AWS::IAM::Role') {
      matrix.set(constructOf(synthesized, id), []);
    }
  }
  for (const found of Object.values(resources(synthesized)).filter(
    (candidate) => candidate['Type'] === 'AWS::IAM::Policy',
  )) {
    const properties = found['Properties'] as JsonObject;
    const statements = (properties['PolicyDocument'] as JsonObject)['Statement'] as unknown as readonly StatementJson[];
    const policyLines = statements.flatMap((statement) => statementLines(synthesized, statement));
    for (const role of properties['Roles'] as readonly JsonObject[]) {
      const lines = matrix.get(constructOf(synthesized, refOf(role)));
      assert.ok(lines !== undefined, 'every policy attaches to a stack role');
      lines.push(...policyLines);
    }
  }
  return new Map([...matrix].map(([role, lines]) => [role, lines.toSorted()]));
}

describe('IAM isolation of the execution stacks (design §9.6)', () => {
  it('a run grants exactly the matrix to the provider, the controller and both variant callers', () => {
    assert.deepEqual(Object.fromEntries(roleMatrix(execution('run'))), {
      'ExperimentCore/Provider/Role': PROVIDER_MATRIX,
      'ExperimentCore/Controller/Role': CONTROLLER_MATRIX.toSorted(),
      'ConventionalVariant/Caller/Role': variantMatrix('ConventionalVariant'),
      'DurableVariant/Caller/Role': variantMatrix('DurableVariant'),
    });
  });

  it('a transport probe grants the core matrix and the probe caller its journal and the provider version', () => {
    assert.deepEqual(Object.fromEntries(roleMatrix(execution('probe'))), {
      'ExperimentCore/Provider/Role': PROVIDER_MATRIX,
      'ExperimentCore/Controller/Role': CONTROLLER_MATRIX.toSorted(),
      'ProbeCaller/Caller/Role': PROBE_MATRIX.toSorted(),
    });
  });

  it('a variant validation grants the core matrix and only its own variant caller', () => {
    for (const [name, construct] of [
      ['conventional', 'ConventionalVariant'],
      ['durable', 'DurableVariant'],
    ] as const) {
      assert.deepEqual(Object.fromEntries(roleMatrix(execution(name))), {
        'ExperimentCore/Provider/Role': PROVIDER_MATRIX,
        'ExperimentCore/Controller/Role': CONTROLLER_MATRIX.toSorted(),
        [`${construct}/Caller/Role`]: variantMatrix(construct),
      });
    }
  });

  it('no caller role reaches the ledger, the control table or the experiment journal (BR-RUA-018)', () => {
    for (const name of ['run', 'probe', 'conventional', 'durable']) {
      const callers = [...roleMatrix(execution(name))].filter(([role]) => role.endsWith('/Caller/Role'));
      for (const [role, lines] of callers) {
        const reached = lines.filter((line) => FORBIDDEN_TO_CALLERS.some((table) => line.endsWith(`-> ${table}`)));
        assert.deepEqual(reached, [], `${name} ${role}`);
      }
    }
  });

  it('no role carries a managed or inline policy, and only stream listing uses *', () => {
    for (const name of ['run', 'probe', 'conventional', 'durable']) {
      const synthesized = execution(name);
      for (const found of Object.values(resources(synthesized)).filter(
        (candidate) => candidate['Type'] === 'AWS::IAM::Role',
      )) {
        const properties = found['Properties'] as JsonObject;
        assert.deepEqual([properties['ManagedPolicyArns'], properties['Policies']], [undefined, undefined]);
      }
      const wildcard = [...roleMatrix(synthesized).values()].flat().filter((line) => line.endsWith('-> *'));
      assert.deepEqual(wildcard, ['dynamodb:ListStreams -> *']);
    }
  });
});
