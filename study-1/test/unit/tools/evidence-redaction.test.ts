// The public redacted copy of the Study 1 packages (close-out Phase 3, spec limitation 10): only
// the account id and the owner's local paths change, every original digest is kept beside the
// redacted one, and a copy that still holds an identifier or no longer parses is refused.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  ACCOUNT_PLACEHOLDER,
  accountIdOf,
  assertPackageDirectories,
  deriveRedactedCopy,
  leaksIn,
  REDACTION_RULE_IDS,
  REDACTION_RULES,
  redactText,
} from '../../../tools/lib/evidence-redaction.ts';
import { redactionReadme } from '../../../tools/lib/redaction-readme.ts';
import { InMemoryEvidence } from './support/in-memory-evidence.ts';
import {
  ACCOUNT,
  DOUBLE_REFUND,
  PASSING,
  PROBE,
  probePackageFiles,
  rawPackageReader,
  redactionEvidence,
  RUN,
  runPackageFiles,
  VALIDATION,
} from './support/redaction-evidence.ts';

const textOf = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const ARN = `arn:aws:sqs:us-east-1:${ACCOUNT}:source`;

describe('deriveRedactedCopy', () => {
  it('copies every indexed file, rewriting only the account id and the local paths', () => {
    const evidence = redactionEvidence();
    const copy = deriveRedactedCopy({ packages: [RUN, PROBE], read: evidence.read });
    const runPaths = [...runPackageFiles([PASSING, DOUBLE_REFUND]).keys()].map((path) => `${RUN}/${path}`);
    assert.deepEqual(
      [...copy.files.keys()],
      [
        `${RUN}/package-index.json`,
        ...runPaths,
        `${PROBE}/package-index.json`,
        `${PROBE}/provisioning/stack.json`,
        'redaction-manifest.json',
        'verdict-recheck.json',
        'README.md',
      ],
    );
    const at = (path: string): string => textOf(copy.files.get(`${RUN}/${path}`));
    assert.equal(
      at('admission/deployment-assembly/stack.metadata.json'),
      '{"trace":["new ExecutionStack (file://<checkout>/study-1/infra/stacks/execution-stack.ts:89:17)"]}',
    );
    assert.equal(
      at('admission/oracle-attestation.json'),
      '{"command":"npm run test:golden -- --report-json <temp-dir>/rua-g/report.json"}',
    );
    assert.equal(
      at(`trials/${PASSING.id}/journals/caller-journal.jsonl`),
      `{"execution_arn":"arn:aws:lambda:us-east-1:${ACCOUNT_PLACEHOLDER}:function:caller:live/durable-execution/x"}\n`,
    );
    assert.equal(
      textOf(copy.files.get(`${PROBE}/provisioning/stack.json`)),
      JSON.stringify({
        bucket: `cdk-hnb659fds-assets-${ACCOUNT_PLACEHOLDER}-us-east-1`,
        queue_url: `https://sqs.us-east-1.amazonaws.com/${ACCOUNT_PLACEHOLDER}/source`,
        account: ACCOUNT_PLACEHOLDER,
        role_arn: `arn:aws:iam::${ACCOUNT_PLACEHOLDER}:role/deployer`,
      }),
    );
    for (const path of [
      `${RUN}/package-index.json`,
      `${RUN}/admission/deployment-assembly/asset.1/index.mjs`,
      `${RUN}/trials/${PASSING.id}/ledger/ledger-snapshot.json`,
    ]) {
      assert.deepEqual(copy.files.get(path), evidence.read(path), path);
    }
  });

  it("records each file's digests and rules, each package's index digests, the recheck and the README", () => {
    const evidence = new InMemoryEvidence();
    evidence.putPackage(PROBE, probePackageFiles());
    const copy = deriveRedactedCopy({ packages: [PROBE], read: evidence.read });
    const original = textOf(evidence.read(`${PROBE}/provisioning/stack.json`));
    const redacted = original.replaceAll(ACCOUNT, ACCOUNT_PLACEHOLDER);
    const index = evidence.indexDigest(PROBE);
    const packages = [{ directory: PROBE, original_package_index_sha256: index, redacted_package_index_sha256: index }];
    assert.deepEqual(copy.manifest, {
      record_type: 'redaction_manifest',
      schema_version: 1,
      derived_by: 'study-1/tools/redact-evidence.ts',
      authority:
        'Each original package-index.json digest is the authority; this copy is a derived view of the packages (spec limitation 10).',
      rules: REDACTION_RULES,
      packages,
      files: [
        { path: `${PROBE}/package-index.json`, original_sha256: index, redacted_sha256: index, rules_applied: {} },
        {
          path: `${PROBE}/provisioning/stack.json`,
          original_sha256: sha(original),
          redacted_sha256: sha(redacted),
          rules_applied: { 'aws-account-id': 4 },
        },
      ],
    });
    assert.equal(textOf(copy.files.get('redaction-manifest.json')), `${JSON.stringify(copy.manifest, null, 2)}\n`);
    assert.deepEqual(copy.rechecks, []);
    assert.equal(textOf(copy.files.get('verdict-recheck.json')), '[]\n');
    assert.equal(
      textOf(copy.files.get('README.md')),
      redactionReadme({
        authority: copy.manifest.authority,
        packages,
        rules: [
          { id: 'aws-account-id', description: REDACTION_RULES['aws-account-id'], files: 1, replacements: 4 },
          { id: 'checkout-path', description: REDACTION_RULES['checkout-path'], files: 0, replacements: 0 },
          { id: 'home-path', description: REDACTION_RULES['home-path'], files: 0, replacements: 0 },
          { id: 'temp-path', description: REDACTION_RULES['temp-path'], files: 0, replacements: 0 },
        ],
        file_count: 2,
        unchanged_count: 1,
        recheck_count: 0,
      }),
    );
  });

  it('counts each rule over every file it changed', () => {
    const copy = deriveRedactedCopy({ packages: [RUN, PROBE], read: redactionEvidence().read });
    assert.match(textOf(copy.files.get('README.md')), /`aws-account-id`: .* Files changed: 3; replacements: 6\./);
    assert.match(textOf(copy.files.get('README.md')), /`temp-path`: .* Files changed: 1; replacements: 1\./);
    assert.match(textOf(copy.files.get('README.md')), /\n13 of the 18 files are byte-identical to the originals\.\n/);
  });

  it('re-derives the verdicts of run packages only', () => {
    const evidence = redactionEvidence();
    // The oracle of this validation trial disagrees with its ledger: rechecking it would refuse.
    evidence.putPackage(VALIDATION, runPackageFiles([{ ...PASSING, verdict: 'fail' }]));
    const copy = deriveRedactedCopy({ packages: [RUN, PROBE, VALIDATION], read: evidence.read });
    assert.deepEqual(
      copy.rechecks.map((one) => [one.trial_id, one.preservation_verdict.redacted_ledger]),
      [
        [PASSING.id, 'pass'],
        [DOUBLE_REFUND.id, 'fail'],
      ],
    );
    assert.equal(textOf(copy.files.get('verdict-recheck.json')), `${JSON.stringify(copy.rechecks, null, 2)}\n`);
  });

  it('refuses a copy that still holds an identifier', () => {
    const evidence = redactionEvidence();
    evidence.putPackage(
      PROBE,
      new Map([['notes.json', { arn: ARN, at: '/var/folders/ab/cd/X/y', n: `9${ACCOUNT}3` }]]),
    );
    assert.throws(() => deriveRedactedCopy({ packages: [PROBE], read: evidence.read }), {
      message: `redacted ${PROBE}/notes.json still holds the account id ${ACCOUNT} and the local path prefix /var/folders/; expected no environment identifier`,
    });
  });

  it('refuses a JSON or JSONL file whose redacted text does not parse, and copies other text as is', () => {
    for (const [path, content] of [
      ['broken.json', `{"arn":"${ARN}"`],
      ['broken.jsonl', `{"arn":"${ARN}"}\nnot json\n`],
    ] as const) {
      const evidence = new InMemoryEvidence();
      evidence.putPackage(PROBE, new Map([[path, content]]));
      assert.throws(() => deriveRedactedCopy({ packages: [PROBE], read: evidence.read }), {
        message: `redacted ${PROBE}/${path} does not parse; expected the JSON of the original file`,
      });
    }
    const evidence = new InMemoryEvidence();
    evidence.putPackage(PROBE, new Map([['index.mjs', `const arn = "${ARN}"; {`]]));
    const copy = deriveRedactedCopy({ packages: [PROBE], read: evidence.read });
    assert.equal(
      textOf(copy.files.get(`${PROBE}/index.mjs`)),
      `const arn = "${ARN.replace(ACCOUNT, ACCOUNT_PLACEHOLDER)}"; {`,
    );
  });

  it('refuses a file that is not UTF-8, naming the byte', () => {
    const encoder = new TextEncoder();
    const read = rawPackageReader(
      PROBE,
      new Map([
        ['arn.txt', encoder.encode(ARN)],
        ['raw.bin', Uint8Array.of(0x61, 0xff)],
      ]),
    );
    assert.throws(() => deriveRedactedCopy({ packages: [PROBE], read }), {
      message: `${PROBE}/raw.bin is not UTF-8 at byte 1; expected UTF-8 text`,
    });
  });

  it('refuses packages that name no account, and malformed package directories', () => {
    const evidence = new InMemoryEvidence();
    evidence.putPackage(PROBE, new Map([['empty.json', {}]]));
    assert.throws(() => deriveRedactedCopy({ packages: [PROBE], read: evidence.read }), {
      message: "the ARNs name accounts []; expected exactly one, the study's sandbox",
    });
    assert.throws(
      () => deriveRedactedCopy({ packages: ['../runs'], read: evidence.read }),
      /got packages \["\.\.\/runs"\]/,
    );
  });
});

describe('redactText', () => {
  it('replaces the account id wherever it stands alone, never inside a longer number', () => {
    const text = `${ARN} cdk-${ACCOUNT}-us /${ACCOUNT}/q "${ACCOUNT}" 1${ACCOUNT} ${ACCOUNT}2`;
    assert.deepEqual(redactText(text, ACCOUNT), {
      text:
        `arn:aws:sqs:us-east-1:${ACCOUNT_PLACEHOLDER}:source cdk-${ACCOUNT_PLACEHOLDER}-us ` +
        `/${ACCOUNT_PLACEHOLDER}/q "${ACCOUNT_PLACEHOLDER}" 1${ACCOUNT} ${ACCOUNT}2`,
      rules_applied: { 'aws-account-id': 4 },
    });
  });

  it('cuts a checkout path down to study-1/, at the first study-1/ segment', () => {
    assert.deepEqual(redactText('file:///Users/alice/Projects/suc/.agent-runs/r-1/study-1/infra/a.ts:51:17', ACCOUNT), {
      text: 'file://<checkout>/study-1/infra/a.ts:51:17',
      rules_applied: { 'checkout-path': 1 },
    });
    assert.deepEqual(redactText('/home/bob/w/study-1/x/study-1/y and /home/bob/study-1/z', ACCOUNT), {
      text: '<checkout>/study-1/x/study-1/y and <checkout>/study-1/z',
      rules_applied: { 'checkout-path': 2 },
    });
  });

  it('replaces any other home prefix and a macOS temporary directory', () => {
    assert.deepEqual(
      redactText(
        '/Users/alice/notes.txt /home/bob.smith-2/x /var/folders/zz/x_1/T/rua-1 /private/var/folders/ab/cd/T/y',
        ACCOUNT,
      ),
      {
        text: '<home>/notes.txt <home>/x <temp-dir>/rua-1 <temp-dir>/y',
        rules_applied: { 'home-path': 2, 'temp-path': 2 },
      },
    );
  });

  it('leaves a temporary directory that is not .../T/ and text without identifiers alone', () => {
    const text = '/var/folders/ab/cd/X/y /var/folders/ab/cd/T /var/folders/ab/T/z /Users/ /study-1/x';
    assert.deepEqual(redactText(text, ACCOUNT), { text, rules_applied: {} });
  });
});

describe('leaksIn', () => {
  it('finds the account id anywhere and a leftover local path prefix', () => {
    assert.deepEqual(leaksIn(`<home>/x 9${ACCOUNT}3 /home/`, ACCOUNT), [
      `the account id ${ACCOUNT}`,
      'the local path prefix /home/',
    ]);
    assert.deepEqual(leaksIn('/Users/', ACCOUNT), ['the local path prefix /Users/']);
    assert.deepEqual(leaksIn('/private/var/folders/x', ACCOUNT), ['the local path prefix /var/folders/']);
    assert.deepEqual(leaksIn(`<home>/x <temp-dir>/y ${ACCOUNT_PLACEHOLDER} /Users /homes/`, ACCOUNT), []);
  });
});

describe('accountIdOf', () => {
  it('reads the account from every ARN shape, ignoring account-less ARNs and other numbers', () => {
    assert.equal(
      accountIdOf([
        `arn:aws:sts::${ACCOUNT}:assumed-role/x`,
        `arn:aws-cn:s3_x:cn-north-1:${ACCOUNT}:y arn:aws:s3:::bucket 210987654321`,
      ]),
      ACCOUNT,
    );
  });

  it('reads the account from an ARN of another partition on its own', () => {
    assert.equal(accountIdOf([`arn:aws-us-gov:sqs:us-gov-west-1:${ACCOUNT}:q`]), ACCOUNT);
  });

  it('refuses texts naming no account or more than one, listing them in order', () => {
    const other = '012345678901';
    assert.throws(() => accountIdOf(['arn:aws:sqs:us-east-1:12345678901:q arn:aws:s3:::b']), {
      message: "the ARNs name accounts []; expected exactly one, the study's sandbox",
    });
    assert.throws(() => accountIdOf([ARN, `arn:aws:sqs:us-east-1:${other}:q`]), {
      message: `the ARNs name accounts ["${other}","${ACCOUNT}"]; expected exactly one, the study's sandbox`,
    });
  });
});

describe('assertPackageDirectories', () => {
  const uuid = '00000000-0000-4000-8000-000000000001';

  it('accepts distinct run, probe and validation directories', () => {
    assert.doesNotThrow(() => {
      assertPackageDirectories([`runs/${uuid}`, `transport-probes/${uuid}`, `variant-validations/${uuid}`]);
    });
  });

  it('refuses none, a path outside the three kinds, a non-UUID or uppercase id, and a repeat', () => {
    for (const directories of [
      [],
      [`x/runs/${uuid}`],
      [`runs/${uuid}/..`],
      [`other/${uuid}`],
      [`runs/${uuid.toUpperCase().replace(/0/g, 'A')}`],
      [`runs/${uuid}`, `runs/${uuid}`],
    ]) {
      assert.throws(
        () => {
          assertPackageDirectories(directories);
        },
        {
          message:
            `got packages ${JSON.stringify(directories)}; expected at least one distinct ` +
            '{runs|transport-probes|variant-validations}/<lowercase UUID> directory',
        },
      );
    }
  });
});

describe('REDACTION_RULES', () => {
  it('states each rule and its placeholder in words, in the order the rules run', () => {
    assert.equal(ACCOUNT_PLACEHOLDER, '111122223333');
    assert.deepEqual(REDACTION_RULE_IDS, ['aws-account-id', 'checkout-path', 'home-path', 'temp-path']);
    assert.deepEqual(REDACTION_RULES, {
      'aws-account-id':
        'The AWS account id that the ARN account segments name becomes 111122223333 wherever it appears: ARNs, bucket names, queue URLs and plain values.',
      'checkout-path':
        'An absolute path through the local repository checkout becomes <checkout>/, kept from study-1/ on.',
      'home-path': 'Any other /Users/<name> or /home/<name> prefix becomes <home>.',
      'temp-path': 'A macOS temporary directory, /var/folders/<a>/<b>/T with or without /private, becomes <temp-dir>.',
    });
  });
});
