// Owner amendment A-09 and decisions 58/65 (A-13): the runner's execution configuration item has
// its own package artifact class, `provider_execution_configuration`. Every index that lists
// package artifacts (evidence, package and amendment indexes) accepts it at an entry, and the
// closed vocabulary still refuses a near miss, so the class cannot drift between the TypeScript
// tuple and the three schemas (catalogue.contract.test.ts ties the whole enum; this pins the
// added member).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import { ARTIFACT_CLASSES } from '../../../../src/record-contract/records/group-c/vocabulary.ts';
import { assertAccepted, assertRejected } from '../../../support/record-contract/group-b-validation.ts';
import { withValueAt } from '../../../support/record-contract/json-paths.ts';
import { toJson } from '../../../support/record-contract/record-builders.ts';
import { firstAmendmentIndex, runPackageIndex } from './examples/package-examples.ts';
import { trialEvidenceIndex } from './examples/trial-evidence-examples.ts';

const INDEXES: readonly (readonly [string, JsonObject])[] = [
  ['evidence_index', toJson(trialEvidenceIndex())],
  ['package_index', toJson(runPackageIndex())],
  ['amendment_index', toJson(firstAmendmentIndex())],
];

describe('A-09 execution configuration artifact class (decision 58)', () => {
  it('is a member of the closed artifact-class vocabulary, after the readiness journals', () => {
    assert.ok(ARTIFACT_CLASSES.includes('provider_execution_configuration'));
    assert.equal(
      ARTIFACT_CLASSES.indexOf('provider_execution_configuration'),
      ARTIFACT_CLASSES.indexOf('controller_canary_journal') + 1,
    );
  });

  it('is accepted as the class of an entry by every index schema', () => {
    for (const [name, index] of INDEXES) {
      assertAccepted(withValueAt(index, ['entries', 0, 'artifact_class'], 'provider_execution_configuration'), name);
    }
  });

  it('still refuses a class outside the vocabulary', () => {
    for (const [name, index] of INDEXES) {
      assertRejected(
        withValueAt(index, ['entries', 0, 'artifact_class'], 'execution_configuration'),
        name,
        '/entries/0/artifact_class enum',
      );
    }
  });
});
