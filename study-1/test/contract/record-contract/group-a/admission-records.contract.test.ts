// AC-RUA-046 (group A) record contracts of admission: the structured rejection and preflight
// journal line (BR-RUA-039, BR-RUA-046), source provenance and the deployment-assembly
// inventory (BR-RUA-042).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_KINDS } from '../../../../src/record-contract/primitives.ts';
import {
  ADMISSION_CHECK_IDS,
  ADMISSION_REJECTION_CLASSES,
} from '../../../../src/record-contract/records/group-a/admission_rejection.ts';
import { PREFLIGHT_CHECK_RESULTS } from '../../../../src/record-contract/records/group-a/preflight_check_recorded.ts';
import {
  admissionRejection,
  deploymentAssemblyInventory,
  failedPreflightCheck,
  passedPreflightCheck,
  sourceProvenance,
} from './support/admission-examples.ts';
import { DIGESTS, IDS } from './support/sample-values.ts';
import { assertAccepted, assertRejected, withField, withPath, withoutField } from './support/validation-assertions.ts';

describe('admission_rejection (BR-RUA-039)', () => {
  it('accepts the canonical rejection for every execution kind', () => {
    for (const kind of EXECUTION_KINDS) {
      assertAccepted(withField(admissionRejection(), 'execution_kind', kind), kind);
    }
  });

  it('classifies the rejection with one AC-RUA-014 input class', () => {
    assert.deepEqual(ADMISSION_REJECTION_CLASSES, [
      'FINANCIAL_INPUT',
      'IDENTITY',
      'SOURCE_PROVENANCE',
      'ACCOUNT',
      'REGION',
      'SAFETY',
      'QUALIFICATION',
      'COORDINATION_CONFIGURATION',
    ]);
    for (const rejectionClass of ADMISSION_REJECTION_CLASSES) {
      assertAccepted(withField(admissionRejection(), 'rejection_class', rejectionClass), rejectionClass);
    }
    assertRejected(withField(admissionRejection(), 'rejection_class', 'LEASE'), '/rejection_class enum', 'unknown');
  });

  it('names one of the admission steps A1 to A15', () => {
    assert.equal(ADMISSION_CHECK_IDS.length, 15);
    for (const checkId of ADMISSION_CHECK_IDS) {
      assertAccepted(withField(admissionRejection(), 'failed_check_id', checkId), checkId);
    }
    for (const checkId of ['A0', 'A16', 'A03', 'a3', 'B1', 'A', '']) {
      assertRejected(withField(admissionRejection(), 'failed_check_id', checkId), '/failed_check_id pattern', checkId);
    }
  });

  it('gives at least one structured reason and no execution identity', () => {
    assertRejected(withField(admissionRejection(), 'reasons', []), '/reasons minItems', 'no reason');
    assertRejected(
      withPath(admissionRejection(), ['reasons', 0, 'code'], 'amount_mismatch'),
      '/reasons/0/code pattern',
      'code',
    );
    assertRejected(
      withPath(admissionRejection(), ['reasons', 0, 'detail'], ''),
      '/reasons/0/detail minLength',
      'detail',
    );
    assertRejected(
      withField(admissionRejection(), 'run_id', IDS.run),
      ' additionalProperties',
      'no manifest, no identity',
    );
  });
});

describe('preflight_check_recorded (BR-RUA-039, BR-RUA-046)', () => {
  it('accepts a passed and a failed check', () => {
    assertAccepted(passedPreflightCheck(), 'passed');
    assertAccepted(failedPreflightCheck(), 'failed');
    assert.deepEqual(PREFLIGHT_CHECK_RESULTS, ['passed', 'failed']);
    assertRejected(withField(passedPreflightCheck(), 'result', 'skipped'), '/result enum', 'skipped');
  });

  it('gives a failed check its rejection class and at least one reason', () => {
    assertRejected(withoutField(failedPreflightCheck(), 'rejection_class'), ' required', 'no class');
    assertRejected(withField(failedPreflightCheck(), 'reasons', []), '/reasons minItems', 'no reason');
  });

  it('gives a passed check no rejection class and no reason', () => {
    assertRejected(
      withField(passedPreflightCheck(), 'rejection_class', 'SAFETY'),
      '/rejection_class false schema',
      'class',
    );
    assertRejected(
      withField(passedPreflightCheck(), 'reasons', failedPreflightCheck().reasons),
      '/reasons maxItems',
      'reason on a pass',
    );
  });

  it('records the boundary, the declared limit, a dense sequence and its evidence', () => {
    assertRejected(withField(passedPreflightCheck(), 'subject', ''), '/subject minLength', 'no boundary');
    assertRejected(withoutField(passedPreflightCheck(), 'expected'), ' required', 'no declared limit');
    assertRejected(withField(passedPreflightCheck(), 'sequence', 0), '/sequence minimum', 'sequence from 1');
    assertRejected(withField(passedPreflightCheck(), 'sequence', 1.5), '/sequence type', 'integral sequence');
    assertRejected(withField(passedPreflightCheck(), 'check_id', 'A16'), '/check_id pattern', 'unknown step');
    const refs = [
      { artifact_path: 'inputs/payment.json', artifact_sha256: DIGESTS.payment },
      { artifact_path: 'inputs/approved-decision.json', artifact_sha256: DIGESTS.approvedDecision },
    ];
    assertRejected(
      withField(failedPreflightCheck(), 'evidence_refs', refs),
      '/evidence_refs x-rua-evidence-ref-order',
      'unsorted',
    );
    assertAccepted(withField(failedPreflightCheck(), 'evidence_refs', refs.toReversed()), 'sorted refs');
    assertRejected(
      withPath(failedPreflightCheck(), ['evidence_refs', 0, 'artifact_path'], '/abs/approved-decision.json'),
      '/evidence_refs/0/artifact_path format',
      'absolute path',
    );
    assertRejected(withField(failedPreflightCheck(), 'evidence', []), ' additionalProperties', 'alias field');
  });
});

describe('source_provenance (BR-RUA-042)', () => {
  it('accepts an attached HEAD with its branch and a detached HEAD without one', () => {
    assertAccepted(sourceProvenance(), 'attached');
    assertAccepted({ ...withoutField(sourceProvenance(), 'branch'), detached_head: true }, 'detached');
    assertRejected(
      withField(sourceProvenance(), 'detached_head', true),
      '/branch false schema',
      'detached with branch',
    );
    assertRejected(withoutField(sourceProvenance(), 'branch'), ' required', 'attached without branch');
  });

  it('exists only for a clean source', () => {
    assertRejected(withField(sourceProvenance(), 'clean_confirmed', false), '/clean_confirmed const', 'dirty');
  });

  it('records git object ids, the tracked lockfile and the tool versions', () => {
    assertAccepted(withField(sourceProvenance(), 'commit_sha', 'a'.repeat(64)), 'SHA-256 repository');
    for (const value of ['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63)]) {
      assertRejected(
        withField(sourceProvenance(), 'commit_sha', value),
        '/commit_sha pattern',
        `${String(value.length)} chars`,
      );
    }
    assertRejected(
      withField(sourceProvenance(), 'lockfile_path', '../package-lock.json'),
      '/lockfile_path format',
      'parent',
    );
    assertRejected(withField(sourceProvenance(), 'tool_versions', {}), '/tool_versions minProperties', 'no tools');
    assertRejected(
      withField(sourceProvenance(), 'tool_versions', { nodeVersion: '24' }),
      '/tool_versions propertyNames',
      'key case',
    );
    assertRejected(
      withPath(sourceProvenance(), ['tool_versions', 'node'], ''),
      '/tool_versions/node pattern',
      'blank version',
    );
  });
});

describe('deployment_assembly_inventory (BR-RUA-042)', () => {
  it('accepts the canonical inventory', () => {
    assertAccepted(deploymentAssemblyInventory(), 'canonical');
  });

  it('lists at least one regular file and refuses a byte-identical duplicate entry', () => {
    assertRejected(withField(deploymentAssemblyInventory(), 'files', []), '/files minItems', 'empty assembly');
    const [first] = deploymentAssemblyInventory().files;
    assertRejected(
      withField(deploymentAssemblyInventory(), 'files', [first, first]),
      '/files uniqueItems',
      'duplicate',
    );
    // One entry per path is a code-level check of the inventory builder (see the schema
    // description): the schema cannot compare one member across items.
    assertAccepted(
      withField(deploymentAssemblyInventory(), 'files', [first, { ...first, sha256: 'e'.repeat(64) }]),
      'same path, other digest: left to the builder',
    );
  });

  it('describes each file by normalized relative path, byte count, mode and digest', () => {
    const [first] = deploymentAssemblyInventory().files;
    assertAccepted(withPath(deploymentAssemblyInventory(), ['files', 0, 'mode'], '0755'), 'executable bits');
    for (const mode of ['644', '0o644', '100644', '0x1A']) {
      assertRejected(
        withPath(deploymentAssemblyInventory(), ['files', 0, 'mode'], mode),
        '/files/0/mode pattern',
        mode,
      );
    }
    for (const path of ['../escape.json', '/etc/passwd', 'a//b.json', './manifest.json']) {
      assertRejected(withPath(deploymentAssemblyInventory(), ['files', 0, 'path'], path), '/files/0/path format', path);
    }
    assertRejected(
      withPath(deploymentAssemblyInventory(), ['files', 0, 'bytes'], -1),
      '/files/0/bytes minimum',
      'bytes',
    );
    assertAccepted(withPath(deploymentAssemblyInventory(), ['files', 0, 'bytes'], 0), 'an empty regular file');
    assertRejected(
      withField(deploymentAssemblyInventory(), 'files', [{ ...first, link_target: 'manifest.json' }]),
      '/files/0 additionalProperties',
      'a symlink cannot be described',
    );
    assertRejected(withoutField(deploymentAssemblyInventory(), 'inventory_sha256'), ' required', 'no digest');
  });
});
