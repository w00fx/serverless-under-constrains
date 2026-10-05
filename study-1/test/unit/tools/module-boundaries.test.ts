// The import rules of design §5.4 over parsed import lists.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkModuleBoundaries, parseBoundaryConfig } from '../../../tools/lib/module-boundaries.ts';
import type { BoundaryConfig, CheckedSourceFile } from '../../../tools/lib/module-boundaries.ts';
import { extractImports } from '../../../tools/lib/source-imports.ts';

const config: BoundaryConfig = {
  layers: {
    'record-contract': 0,
    settlement: 1,
    'provider-client': 2,
    'refund-provider': 2,
    'conventional-variant': 3,
    'durable-variant': 3,
    'trial-oracle': 3,
    'treatment-fidelity': 3,
    admission: 4,
    'deployment-assembly': 4,
  },
  same_layer_edges: [
    { from: 'durable-variant', to: 'conventional-variant', paths: ['request-state/'] },
    { from: 'trial-oracle', to: 'treatment-fidelity' },
    { from: 'admission', to: 'deployment-assembly', type_only: true },
  ],
  denied_imports: [
    {
      features: ['trial-oracle', 'settlement'],
      specifiers: ['fs'],
      specifier_prefixes: ['node:fs', '@aws-sdk/'],
      path_segments: ['/aws/'],
    },
    { features: ['trial-oracle'], specifiers: [], specifier_prefixes: ['node:'], path_segments: [] },
  ],
  denied_feature_imports: [{ features: ['conventional-variant'], targets: ['refund-provider'] }],
  denied_tokens: [{ features: ['conventional-variant'], tokens: ["'ledger'"] }],
  infra_may_import: ['record-contract'],
  src_may_import_infra: ['infra/ownership/'],
};

function file(path: string, text: string): CheckedSourceFile {
  return { path, text, imports: extractImports(path, text) };
}

function rulesOf(...files: readonly CheckedSourceFile[]): readonly string[] {
  return checkModuleBoundaries(config, files).map((violation) => `${violation.path} ${violation.rule}`);
}

describe('checkModuleBoundaries', () => {
  it('allows inward imports, own-feature imports and packages', () => {
    const source = file(
      'src/trial-oracle/verdict.ts',
      "import { a } from '../record-contract/parsing.ts';\nimport { b } from './rules.ts';\nimport { c } from '../settlement/s.ts';\nimport fc from 'fast-check';\nimport { d } from '../treatment-fidelity/t.ts';",
    );
    assert.deepEqual(checkModuleBoundaries(config, [source]), []);
  });

  it('refuses an outward or unlisted same-layer import', () => {
    const outward = checkModuleBoundaries(config, [
      file('src/settlement/s.ts', "import { x } from '../provider-client/p.ts';"),
    ]);
    assert.deepEqual(outward, [
      {
        path: 'src/settlement/s.ts',
        rule: 'OUTWARD_IMPORT',
        detail:
          'settlement (L1) imports provider-client (L2) via ../provider-client/p.ts; expected a strictly lower layer or a declared same-layer edge',
      },
    ]);
    assert.deepEqual(rulesOf(file('src/conventional-variant/c.ts', "import { x } from '../durable-variant/d.ts';")), [
      'src/conventional-variant/c.ts OUTWARD_IMPORT',
    ]);
    assert.deepEqual(rulesOf(file('src/record-contract/r.ts', "import { x } from '../settlement/s.ts';")), [
      'src/record-contract/r.ts OUTWARD_IMPORT',
    ]);
  });

  it('restricts a same-layer edge to its declared paths', () => {
    assert.deepEqual(
      rulesOf(file('src/durable-variant/d.ts', "import { x } from '../conventional-variant/request-state/store.ts';")),
      [],
    );
    const outside = checkModuleBoundaries(config, [
      file('src/durable-variant/d.ts', "import { x } from '../conventional-variant/caller.ts';"),
    ]);
    assert.deepEqual(outside, [
      {
        path: 'src/durable-variant/d.ts',
        rule: 'EDGE_PATH_NOT_ALLOWED',
        detail:
          '../conventional-variant/caller.ts resolves to src/conventional-variant/caller.ts; the durable-variant -> conventional-variant edge allows only request-state/',
      },
    ]);
  });

  it('restricts a type-only edge to type-only imports', () => {
    assert.deepEqual(
      rulesOf(file('src/admission/a.ts', "import type { Inventory } from '../deployment-assembly/inventory.ts';")),
      [],
    );
    assert.deepEqual(
      checkModuleBoundaries(config, [
        file('src/admission/a.ts', "import { assemble } from '../deployment-assembly/inventory.ts';"),
      ]),
      [
        {
          path: 'src/admission/a.ts',
          rule: 'EDGE_REQUIRES_TYPE_ONLY',
          detail:
            '../deployment-assembly/inventory.ts is a value import; the admission -> deployment-assembly edge allows type-only imports',
        },
      ],
    );
  });

  it('applies hard denials of specifiers, prefixes and path segments', () => {
    const denied = checkModuleBoundaries(config, [
      file(
        'src/settlement/s.ts',
        "import fs from 'fs';\nimport { x } from '@aws-sdk/client-sqs';\nimport { y } from './aws/port.ts';\nimport { z } from 'node:fs/promises';\nimport { w } from 'node:path';",
      ),
    ]);
    assert.deepEqual(
      denied.map((violation) => violation.detail),
      [
        'settlement must not import fs (denied: fs, node:fs, @aws-sdk/, /aws/)',
        'settlement must not import @aws-sdk/client-sqs (denied: fs, node:fs, @aws-sdk/, /aws/)',
        'settlement must not import ./aws/port.ts (denied: fs, node:fs, @aws-sdk/, /aws/)',
        'settlement must not import node:fs/promises (denied: fs, node:fs, @aws-sdk/, /aws/)',
      ],
    );
    assert.deepEqual(rulesOf(file('src/trial-oracle/o.ts', "import { w } from 'node:path';")), [
      'src/trial-oracle/o.ts DENIED_IMPORT',
    ]);
    assert.deepEqual(rulesOf(file('src/trial-oracle/o.ts', "import fs from 'node:fs';")), [
      'src/trial-oracle/o.ts DENIED_IMPORT',
      'src/trial-oracle/o.ts DENIED_IMPORT',
    ]);
    assert.deepEqual(
      rulesOf(file('src/provider-client/p.ts', "import fs from 'fs';\nimport { y } from './aws/port.ts';")),
      [],
    );
  });

  it('refuses a denied feature import even toward a lower layer', () => {
    assert.deepEqual(
      checkModuleBoundaries(config, [
        file('src/conventional-variant/c.ts', "import { x } from '../refund-provider/r.ts';"),
      ]),
      [
        {
          path: 'src/conventional-variant/c.ts',
          rule: 'DENIED_FEATURE_IMPORT',
          detail: 'conventional-variant must not import refund-provider (../refund-provider/r.ts)',
        },
      ],
    );
  });

  it('refuses denied tokens in the source text', () => {
    assert.deepEqual(
      checkModuleBoundaries(config, [file('src/conventional-variant/c.ts', "const table = 'ledger';")]),
      [
        {
          path: 'src/conventional-variant/c.ts',
          rule: 'DENIED_TOKEN',
          detail: "conventional-variant must not reference 'ledger'",
        },
      ],
    );
    assert.deepEqual(rulesOf(file('src/settlement/s.ts', "const table = 'ledger';")), []);
  });

  it('refuses undeclared features on either side of an import', () => {
    assert.deepEqual(
      checkModuleBoundaries(config, [file('src/mystery/m.ts', "import { x } from '../record-contract/r.ts';")]),
      [
        {
          path: 'src/mystery/m.ts',
          rule: 'UNDECLARED_FEATURE',
          detail: 'src/mystery is not a feature folder declared in quality/module-boundaries.json layers',
        },
      ],
    );
    assert.deepEqual(rulesOf(file('src/loose.ts', '')), ['src/loose.ts UNDECLARED_FEATURE']);
    assert.deepEqual(
      checkModuleBoundaries(config, [file('src/settlement/s.ts', "import { x } from '../mystery/m.ts';")]),
      [
        {
          path: 'src/settlement/s.ts',
          rule: 'UNDECLARED_FEATURE',
          detail: '../mystery/m.ts resolves into undeclared feature "mystery"',
        },
      ],
    );
  });

  it('confines src imports of infra and of anything outside src', () => {
    assert.deepEqual(
      rulesOf(file('src/settlement/s.ts', "import { tags } from '../../infra/ownership/ownership-tags.ts';")),
      [],
    );
    assert.deepEqual(
      checkModuleBoundaries(config, [
        file('src/settlement/s.ts', "import { f } from '../../infra/constructs/observable-function.ts';"),
      ]),
      [
        {
          path: 'src/settlement/s.ts',
          rule: 'SRC_IMPORTS_INFRA',
          detail:
            '../../infra/constructs/observable-function.ts resolves to infra/constructs/observable-function.ts; src may import only infra/ownership/',
        },
      ],
    );
    assert.deepEqual(
      checkModuleBoundaries(config, [
        file('src/settlement/s.ts', "import { t } from '../../test/support/kernel/x.ts';"),
      ]),
      [
        {
          path: 'src/settlement/s.ts',
          rule: 'IMPORT_OUTSIDE_SOURCE',
          detail:
            '../../test/support/kernel/x.ts resolves to test/support/kernel/x.ts; expected src/ or an allowed infra path',
        },
      ],
    );
  });

  it('lets infra import only the listed features', () => {
    assert.deepEqual(
      rulesOf(
        file(
          'infra/stacks/s.ts',
          "import { a } from '../../src/record-contract/r.ts';\nimport { b } from '../ownership/o.ts';\nimport { Stack } from 'aws-cdk-lib';",
        ),
      ),
      [],
    );
    assert.deepEqual(
      checkModuleBoundaries(config, [file('infra/stacks/s.ts', "import { a } from '../../src/settlement/s.ts';")]),
      [
        {
          path: 'infra/stacks/s.ts',
          rule: 'INFRA_IMPORTS_FEATURE_CODE',
          detail: '../../src/settlement/s.ts reaches src/settlement; infra may import only record-contract',
        },
      ],
    );
  });

  it('ignores files outside src and infra', () => {
    assert.deepEqual(
      rulesOf(file('tools/x.ts', "import { a } from '../src/settlement/s.ts';\nconst t = 'ledger';")),
      [],
    );
  });

  it('checks every file', () => {
    assert.deepEqual(rulesOf(file('src/mystery/a.ts', ''), file('src/other/b.ts', '')), [
      'src/mystery/a.ts UNDECLARED_FEATURE',
      'src/other/b.ts UNDECLARED_FEATURE',
    ]);
  });
});

describe('parseBoundaryConfig', () => {
  it('accepts a complete configuration', () => {
    assert.equal(parseBoundaryConfig(config), config);
  });

  it('refuses malformed layers', () => {
    for (const layers of [undefined, null, [], { a: -1 }, { a: 1.5 }, { a: '1' }]) {
      assert.throws(() => parseBoundaryConfig({ ...config, layers }), {
        message: `layers is ${JSON.stringify(layers)}; expected an object of feature name to nonnegative integer layer`,
      });
    }
    assert.throws(() => parseBoundaryConfig(null), {
      message: 'layers is undefined; expected an object of feature name to nonnegative integer layer',
    });
  });

  it('requires every rule list', () => {
    const { denied_tokens: _tokens, src_may_import_infra: _infra, ...partial } = config;
    assert.throws(() => parseBoundaryConfig({ ...partial, denied_imports: {} }), {
      message:
        'module boundaries lack array field(s) denied_imports, denied_tokens, src_may_import_infra; expected every rule list to be present',
    });
  });

  it('refuses rules that name undeclared features', () => {
    const broken = {
      ...config,
      same_layer_edges: [
        { from: 'ghost', to: 'settlement' },
        { from: 'settlement', to: 'phantom' },
      ],
      denied_imports: [{ features: ['spirit'], specifiers: [], specifier_prefixes: [], path_segments: [] }],
      denied_feature_imports: [{ features: ['wraith'], targets: ['shade'] }],
      denied_tokens: [{ features: ['ghost'], tokens: [] }],
      infra_may_import: ['specter'],
    };
    assert.throws(() => parseBoundaryConfig(broken), {
      message:
        'rules name undeclared feature(s) ghost, phantom, spirit, wraith, shade, specter; expected every feature to have a layer',
    });
  });
});
