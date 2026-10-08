// The syntax-aware RK-12 scan of a bundled ES module (design §9.8 S3; A-14 fix of the text scan,
// found by WP-24 on 2026-10-06). Expected values follow JavaScript's own grammar: a bare
// `@aws-sdk/` specifier counts only when a static import, re-export, side-effect import, dynamic
// import or `require`/`__require` call loads it from code. Most "false" cases are discriminating:
// they put a quoted load right after a token whose regular-expression-or-division reading decides
// whether the quote opens a string, so the opposite reading would report a load.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadsBareAwsSdk } from '../../../src/evidence-package/bundle-module-loads.ts';

const QUOTED_LOAD = `const u = 'require("@aws-sdk/a")';`;
const DEEP = 100_000;

function check(cases: readonly (readonly [string, boolean])[]): void {
  for (const [source, expected] of cases) {
    assert.equal(loadsBareAwsSdk(source), expected, source);
  }
}

describe('loadsBareAwsSdk', () => {
  it('finds every load form in code', () => {
    check([
      ['import { S3 } from "@aws-sdk/client-s3";', true],
      ["export * from '@aws-sdk/client-sqs';", true],
      ['import "@aws-sdk/side-effect";', true],
      ['const m = await import ( "@aws-sdk/client-lambda" );', true],
      ["const m = require('@aws-sdk/client-sts');", true],
      ['var m = __require("@aws-sdk/client-sts");', true],
      ['const t = `${require("@aws-sdk/a")}`;', true],
      ['const all = [...require("@aws-sdk/a")];', true],
      ['#!/usr/bin/env node\nimport "@aws-sdk/a";', true],
      ['const re = /["\'`]/g;\nimport("@aws-sdk/a");', true],
    ]);
  });

  it('ignores loads quoted in strings, templates, comments and regular expressions', () => {
    check([
      ['throw new Error(`calling [require("@aws-sdk/signature-v4-crt");] or [import "@aws-sdk/x";]`);', false],
      [`throw new Error("[require('@aws-sdk/signature-v4a');] or [import '@aws-sdk/signature-v4a';]");`, false],
      ['const t = `a${b}require("@aws-sdk/a")`;', false],
      ['// import "@aws-sdk/a";\nexport const a = 1;', false],
      ['/* export * from "@aws-sdk/a"; */ export const a = 1;', false],
      ['const set = /[from "@aws-sdk/]/u;', false],
      ['const s = "line\\\r\nrequire(\'@aws-sdk/a\')";', false],
    ]);
  });

  it('reads a word after `.` as a property name, never as a load', () => {
    check([
      ['client.require("@aws-sdk/client-sts");', false],
      ['client.import("@aws-sdk/client-sts");', false],
      ['const url = import.meta.url;', false],
      ['import { a } from "./local.mjs"; const b = require("node:fs");', false],
    ]);
  });

  // Ported from the dropped A-14 fix e49cda1 (decision 72): a call of any other function, a load of
  // a non-SDK module and a load whose argument is not a string literal never count.
  it('ignores other calls, non-SDK loads and non-literal or absent load arguments', () => {
    check([
      ['import { join } from "node:path"; const x = require("@smithy/x"); const y = load("@aws-sdk/z");', false],
      ['const name = "@aws-sdk/q7"; require(name); import(name); require(); import();', false],
    ]);
  });

  it('reads `/` after an operator, an opening bracket, a block or a keyword as a regular expression', () => {
    check([
      [`const r = a + /'/.test(b) + 'require("@aws-sdk/a")';`, false],
      [`if (a(b)) /'/.test(b); ${QUOTED_LOAD}`, false],
      [`function f(x) { return /'/.test(x) ? 'require("@aws-sdk/a")' : 0; }`, false],
      [`{ }\n/'/.test(x); ${QUOTED_LOAD}`, false],
      [`const r = (/'/).source; ${QUOTED_LOAD}`, false],
    ]);
  });

  it('reads `/` after an operand as division', () => {
    check([
      [`const r = a / b; const t = '/'; ${QUOTED_LOAD}`, false],
      [`const r = x++ / 2; const t = '/'; ${QUOTED_LOAD}`, false],
      [`const r = f(x) / 2; const t = '/'; ${QUOTED_LOAD}`, false],
      [`const r = list[0] / 2; const t = '/'; ${QUOTED_LOAD}`, false],
      [`const r = x.return / 2; const t = '/'; ${QUOTED_LOAD}`, false],
      [`const r = 10 / 2; const t = '/'; ${QUOTED_LOAD}`, false],
      [`const r = .5 / 2; const t = '/'; ${QUOTED_LOAD}`, false],
      [`const r = "s" / 2; const t = '/'; ${QUOTED_LOAD}`, false],
      [`const r = \`s\` / 2; const t = '/'; ${QUOTED_LOAD}`, false],
      [`const r = /a/ / 2; const t = '/'; ${QUOTED_LOAD}`, false],
    ]);
  });

  it('reads a `/` whose literal would cross a line break as division', () => {
    check([[`const r = 1 + /\n2; ${QUOTED_LOAD}`, false]]);
  });

  it('falls back to the text scan when the tokens cannot be trusted (fail closed)', () => {
    check([
      ['/* import "@aws-sdk/a";', true],
      ['/* no load here', false],
      ["const s = \"open\nrequire('@aws-sdk/a')", true],
      ["const s = 'open", false],
      ['const t = `open', false],
      ['const t = `open\\', false],
      ['const t = `${ "require(\'@aws-sdk/a\')" ', true],
      ['const t = `${ 1 ', false],
    ]);
  });

  it('is total and iterative on deep nesting, huge numbers and inherited member names (A-05)', () => {
    check([
      ['('.repeat(DEEP), false],
      ['{'.repeat(DEEP), false],
      ['['.repeat(DEEP), false],
      ['`${'.repeat(DEEP), false],
      [`${'('.repeat(DEEP)}require("@aws-sdk/a")`, true],
      [`${'}'.repeat(DEEP)}${')'.repeat(DEEP)} / 2; ${QUOTED_LOAD}`, false],
      [`const n = 1e400 / 2; const t = '/'; ${QUOTED_LOAD}`, false],
      ['const constructor = 1; toString(__proto__, hasOwnProperty, valueOf);', false],
      ['', false],
    ]);
  });
});
