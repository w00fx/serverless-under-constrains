// The operator CLI grammar (design §11): longest matching command words, operands in order, one
// value per flag, `--evidence-root` global with the default `evidence`, and every refusal a
// USAGE_ERROR naming the offending token and the expected shape (A-05: inherited names are
// unknown flags, never properties).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_EVIDENCE_ROOT,
  matchCommand,
  parseArgs,
  usageLines,
  usageReason,
} from '../../../src/operator-cli/arg-parsing.ts';
import { RecordingCliCommand } from './support/recording-cli-command.ts';

const verify = new RecordingCliCommand(['probe', 'verify'], ['package'], { head: 'optional' });
const admit = new RecordingCliCommand(['probe', 'admit'], [], { env: 'required' });
const recover = new RecordingCliCommand(['recover'], ['package'], { 'confirm-cloud-mutation': 'required' });
const oracle = new RecordingCliCommand(['oracle'], ['trial-dir']);
const oracleEvaluate = new RecordingCliCommand(['oracle', 'evaluate'], ['trial-dir']);
const COMMANDS = [verify, admit, recover, oracle, oracleEvaluate];

describe('parseArgs', () => {
  it('parses words, operands and flags, with the default evidence root', () => {
    const parsed = parseArgs(['probe', 'verify', 'evidence/transport-probes/x', '--head', 'abc'], COMMANDS);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.command, 'probe verify');
    assert.deepEqual([...parsed.value.positionals], [['package', 'evidence/transport-probes/x']]);
    assert.deepEqual([...parsed.value.flags], [['head', 'abc']]);
    assert.equal(parsed.value.evidence_root, DEFAULT_EVIDENCE_ROOT);
    assert.equal(DEFAULT_EVIDENCE_ROOT, 'evidence');
  });

  it('takes the global --evidence-root out of the command flags', () => {
    const parsed = parseArgs(['recover', 'p', '--evidence-root', '/e', '--confirm-cloud-mutation', 'id'], COMMANDS);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.evidence_root, '/e');
    assert.deepEqual([...parsed.value.flags], [['confirm-cloud-mutation', 'id']]);
  });

  it('accepts flags before operands', () => {
    const parsed = parseArgs(['probe', 'verify', '--head', 'abc', 'pkg'], COMMANDS);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.positionals.get('package'), 'pkg');
  });

  it('prefers the longest matching command words', () => {
    const parsed = parseArgs(['oracle', 'evaluate', 'trials/t'], COMMANDS);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.command, 'oracle evaluate');
    assert.equal(parsed.value.positionals.get('trial-dir'), 'trials/t');
    assert.equal(matchCommand(['oracle', 'trials/t'], COMMANDS)?.spec.words.join(' '), 'oracle');
  });

  it('refuses an unknown command, naming the known ones', () => {
    const parsed = parseArgs(['probe', 'launch'], COMMANDS);
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.error, {
      code: 'USAGE_ERROR',
      subject: 'operator-cli',
      detail:
        'no known command starts ["probe","launch"]; expected one of: probe verify, probe admit, recover, oracle, oracle evaluate',
    });
  });

  it('refuses an empty argument vector', () => {
    const parsed = parseArgs([], COMMANDS);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.detail, /^no known command starts \[\]; expected one of: /);
  });

  it('refuses too few and too many operands with the usage line', () => {
    const few = parseArgs(['probe', 'verify'], COMMANDS);
    assert.equal(few.ok, false);
    assert.equal(few.error.detail, '0 operand(s) [] were given; expected usage: probe verify <package>');
    const many = parseArgs(['probe', 'verify', 'a', 'b'], COMMANDS);
    assert.equal(many.ok, false);
    assert.equal(many.error.detail, '2 operand(s) ["a","b"] were given; expected usage: probe verify <package>');
  });

  it('refuses an empty operand', () => {
    const parsed = parseArgs(['probe', 'verify', ''], COMMANDS);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.detail, 'an empty operand was given; expected usage: probe verify <package>');
  });

  it('refuses a missing required flag', () => {
    const parsed = parseArgs(['probe', 'admit'], COMMANDS);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.detail, '--env missing; expected usage: probe admit');
  });

  it('refuses an unknown flag, an inherited member name included', () => {
    for (const token of ['--rev', '--constructor', '--__proto__', '--HEAD', '--a--b', '---']) {
      const parsed = parseArgs(['probe', 'verify', 'p', token, 'x'], COMMANDS);
      assert.equal(parsed.ok, false, token);
      assert.equal(
        parsed.error.detail,
        `flag ${JSON.stringify([token])} is not a flag of this command; expected usage: probe verify <package>`,
      );
    }
  });

  it('refuses a repeated flag', () => {
    const parsed = parseArgs(['probe', 'verify', 'p', '--head', 'a', '--head', 'b'], COMMANDS);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.detail, 'flag --head was given twice; expected each flag at most once');
  });

  it('refuses a flag with no value, an empty value or another flag as value', () => {
    for (const tail of [['--head'], ['--head', ''], ['--head', '--evidence-root']]) {
      const parsed = parseArgs(['probe', 'verify', 'p', ...tail], COMMANDS);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error.detail, 'flag --head has no value; expected --head <value>');
    }
  });

  it('bounds the quoted tokens of a refusal', () => {
    const parsed = parseArgs(['x'.repeat(5_000)], COMMANDS);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.error.detail.length < 500);
  });
});

describe('usageLines and usageReason', () => {
  it('lists every command with the global flag', () => {
    assert.deepEqual(usageLines([verify, recover]), [
      'rua probe verify <package> [--evidence-root <dir>]',
      'rua recover <package> [--evidence-root <dir>]',
    ]);
  });

  it('states the problem and the expected shape', () => {
    assert.deepEqual(usageReason('p', 'e'), { code: 'USAGE_ERROR', subject: 'operator-cli', detail: 'p; expected e' });
  });
});
