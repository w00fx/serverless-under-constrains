// The shared readings of cleanup's SDK output (design §9.14, Owner amendment A-05): which failure
// means "not found", how a listing pages (bounded, refusing a repeated cursor), how tags and
// untrusted members are read, and the malformed-output reason naming the value and the shape.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ok } from '../../../src/record-contract/primitives.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { Page, Reading } from '../../../src/cleanup/surface-readings.ts';
import {
  collectPages,
  createdAt,
  failureReason,
  instantOfMillis,
  isNotFound,
  malformedOutput,
  MALFORMED_OUTPUT,
  MAX_PAGES,
  optionalInstant,
  optionalText,
  ownMember,
  pageWithCursor,
  readEachEntry,
  requiredText,
  sdkFailureOf,
  sighting,
  tagMap,
  tagObservation,
  tagPairs,
} from '../../../src/cleanup/surface-readings.ts';

function malformed(subject: string, detail: string): ReturnType<typeof malformedOutput> {
  return { ok: false, error: { code: MALFORMED_OUTPUT, subject, detail } };
}

describe('sdkFailureOf', () => {
  it('reads the name and message of a thrown SDK error', () => {
    const thrown = Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' });
    assert.deepEqual(sdkFailureOf(thrown), { name: 'ResourceNotFoundException', message: 'gone' });
  });

  it('reads own name and message members of a thrown non-error', () => {
    assert.deepEqual(sdkFailureOf({ name: 'Throttling', message: 'slow' }), { name: 'Throttling', message: 'slow' });
  });

  it('names a failure without a usable name and drops a message that is not text', () => {
    assert.deepEqual(sdkFailureOf({ name: '', message: 7 }), { name: 'UnnamedSdkFailure', message: '' });
    assert.deepEqual(sdkFailureOf('boom'), { name: 'UnnamedSdkFailure', message: '' });
    assert.deepEqual(sdkFailureOf(Object.create({ name: 'Inherited', message: 'm' }) as unknown), {
      name: 'UnnamedSdkFailure',
      message: '',
    });
  });

  it('bounds a long name to 64 characters', () => {
    assert.equal(sdkFailureOf({ name: 'N'.repeat(200), message: '' }).name, 'N'.repeat(64));
    assert.equal(sdkFailureOf({ name: `${'N'.repeat(63)}X`, message: '' }).name, `${'N'.repeat(63)}X`);
    assert.equal(sdkFailureOf({ name: `${'N'.repeat(64)}X`, message: '' }).name, 'N'.repeat(64));
  });

  it('never throws on a value whose members throw when read', () => {
    const hostile = {
      get name(): string {
        throw new Error('getter');
      },
    };
    assert.deepEqual(sdkFailureOf(hostile), {
      name: 'UnnamedSdkFailure',
      message: 'the thrown value could not be read',
    });
  });
});

describe('isNotFound', () => {
  it('holds for the not-found errors of every service cleanup calls', () => {
    for (const name of ['ResourceNotFoundException', 'QueueDoesNotExist', 'NoSuchEntityException']) {
      assert.equal(isNotFound({ name, message: '' }), true, name);
    }
    const missingStack = 'Stack with id arn:aws:cloudformation:us-east-1:1:stack/s/g does not exist';
    assert.equal(isNotFound({ name: 'ValidationError', message: missingStack }), true);
  });

  it('does not hold for any other failure', () => {
    assert.equal(isNotFound({ name: 'ThrottlingException', message: 'does not exist' }), false);
    assert.equal(isNotFound({ name: 'ValidationError', message: 'Stack with id s is in DELETE_IN_PROGRESS' }), false);
    assert.equal(isNotFound({ name: 'ValidationError', message: 'Template does not exist' }), false);
    assert.equal(isNotFound({ name: 'DeleteConflictException', message: '' }), false);
  });
});

describe('failureReason', () => {
  it('codes the reason by the error name and names the subject and the expectation', () => {
    assert.deepEqual(failureReason({ name: 'ThrottlingException', message: 'slow down' }, 'subject-1', 'a table'), {
      code: 'THROTTLING_EXCEPTION',
      subject: 'subject-1',
      detail: 'ThrottlingException: slow down; expected a table',
    });
  });
});

describe('collectPages', () => {
  function pages(...scripted: Reading<Page<number>>[]): (cursor: string | undefined) => Promise<Reading<Page<number>>> {
    const queue = [...scripted];
    return () => Promise.resolve(queue.shift() ?? ok({ items: [] }));
  }

  it('joins every page until a page has no cursor, passing each cursor on', async () => {
    const seen: (string | undefined)[] = [];
    const fetch = pages(ok({ items: [1], cursor: 'a' }), ok({ items: [2, 3], cursor: 'b' }), ok({ items: [4] }));
    const listing = await collectPages((cursor) => {
      seen.push(cursor);
      return fetch(cursor);
    }, 'subject');
    assert.deepEqual(listing, ok([1, 2, 3, 4]));
    assert.deepEqual(seen, [undefined, 'a', 'b']);
  });

  it('stops at the first failed page', async () => {
    const failure = malformed('ListQueues', 'x');
    const listing = await collectPages(pages(ok({ items: [1], cursor: 'a' }), failure), 'subject');
    assert.deepEqual(listing, failure);
  });

  it('refuses a cursor already followed', async () => {
    const listing = await collectPages(
      pages(ok({ items: [1], cursor: 'a' }), ok({ items: [2], cursor: 'b' }), ok({ items: [3], cursor: 'a' })),
      'ListAliases',
    );
    assert.deepEqual(listing, {
      ok: false,
      error: {
        code: 'PAGINATION_CURSOR_REPEATED',
        subject: 'ListAliases',
        detail: 'cursor "a" repeated; expected a listing that ends',
      },
    });
  });

  it('refuses more pages than the bound, reading exactly the bound', async () => {
    let reads = 0;
    const listing = await collectPages(
      () => {
        reads += 1;
        return Promise.resolve(ok({ items: [reads], cursor: `c${String(reads)}` }));
      },
      'GetResources',
      3,
    );
    assert.equal(reads, 3);
    assert.deepEqual(listing, {
      ok: false,
      error: {
        code: 'PAGINATION_LIMIT_EXCEEDED',
        subject: 'GetResources',
        detail: 'more than 3 pages; expected a listing that ends',
      },
    });
  });

  it('reads at most MAX_PAGES pages by default', async () => {
    let reads = 0;
    await collectPages(() => {
      reads += 1;
      return Promise.resolve(ok({ items: [], cursor: String(reads) }));
    }, 'subject');
    assert.equal(reads, MAX_PAGES);
    assert.equal(MAX_PAGES, 100);
  });

  it('ends on the last allowed page when it carries no cursor', async () => {
    const listing = await collectPages(pages(ok({ items: [1], cursor: 'a' }), ok({ items: [2] })), 'subject', 2);
    assert.deepEqual(listing, ok([1, 2]));
  });
});

describe('tag readings', () => {
  it('reads a tag map, an absent map as no tags, and refuses a non-map or a non-text value', () => {
    assert.deepEqual(
      tagMap({ Tags: { a: '1', b: '' } }, 'Tags', 'ListTags'),
      ok([
        { key: 'a', value: '1' },
        { key: 'b', value: '' },
      ]),
    );
    assert.deepEqual(tagMap({}, 'Tags', 'ListTags'), ok([]));
    assert.deepEqual(
      tagMap({ Tags: [] }, 'Tags', 'ListTags'),
      malformed('ListTags', 'Tags is a list; expected a map of tag keys to string values'),
    );
    assert.deepEqual(
      tagMap({ Tags: null }, 'Tags', 'ListTags'),
      malformed('ListTags', 'Tags is null; expected a map of tag keys to string values'),
    );
    assert.deepEqual(
      tagMap({ Tags: 'x' }, 'Tags', 'ListTags'),
      malformed('ListTags', 'Tags is "x"; expected a map of tag keys to string values'),
    );
    assert.deepEqual(
      tagMap({ tags: { k: 1 } }, 'tags', 'ListTagsForResource'),
      malformed('ListTagsForResource', 'tags.k is 1; expected a string tag value'),
    );
  });

  it('reads tag pairs and refuses a pair without a key or with a non-text value', () => {
    assert.deepEqual(tagPairs({ Tags: [{ Key: 'k', Value: '' }] }, 'ListRoleTags'), ok([{ key: 'k', value: '' }]));
    assert.deepEqual(tagPairs({}, 'ListRoleTags'), ok([]));
    assert.deepEqual(
      tagPairs({ Tags: [{ Value: 'v' }] }, 'ListRoleTags'),
      malformed('ListRoleTags.Tags[0]', 'Key is absent; expected a non-empty string'),
    );
    assert.deepEqual(
      tagPairs({ Tags: [{ Key: 'k', Value: true }] }, 'ListRoleTags'),
      malformed('ListRoleTags.Tags[0]', 'Value is true; expected a string'),
    );
  });

  it('observes read tags as tagged and a failed read as unknown', () => {
    assert.deepEqual(tagObservation(ok([{ key: 'k', value: 'v' }])), {
      kind: 'tagged',
      tags: [{ key: 'k', value: 'v' }],
    });
    const reason = { code: 'C', subject: 's', detail: 'd' };
    assert.deepEqual(tagObservation({ ok: false, error: reason }), { kind: 'unknown', reason });
  });
});

describe('member readers', () => {
  it('reads only own members of objects', () => {
    assert.equal(ownMember({ a: 1 }, 'a'), 1);
    assert.equal(ownMember({}, 'toString'), undefined);
    assert.equal(ownMember(Object.create({ a: 1 }) as unknown, 'a'), undefined);
    assert.equal(ownMember(null, 'a'), undefined);
    assert.equal(ownMember('text', 'length'), undefined);
  });

  it('reads each entry of a list, an absent list as empty, and stops at the first failure', () => {
    const asText = (entry: unknown, where: string): Reading<string> =>
      typeof entry === 'string' ? ok(entry) : malformedOutput(where, 'entry', entry, 'text');
    assert.deepEqual(readEachEntry({ L: ['a', 'b'] }, 'L', 'Op', asText), ok(['a', 'b']));
    assert.deepEqual(readEachEntry({}, 'L', 'Op', asText), ok([]));
    assert.deepEqual(
      readEachEntry({ L: {} }, 'L', 'Op', asText),
      malformed('Op', 'L is a value of type object; expected a list'),
    );
    assert.deepEqual(
      readEachEntry({ L: ['a', 2, 3] }, 'L', 'Op', asText),
      malformed('Op.L[1]', 'entry is 2; expected text'),
    );
  });

  it('continues a page by a text cursor and ends it on an absent, null or empty one', () => {
    assert.deepEqual(pageWithCursor([1], { Next: 't' }, 'Op', 'Next'), ok({ items: [1], cursor: 't' }));
    assert.deepEqual(pageWithCursor([1], {}, 'Op', 'Next'), ok({ items: [1] }));
    assert.deepEqual(pageWithCursor([1], { Next: null }, 'Op', 'Next'), ok({ items: [1] }));
    assert.deepEqual(pageWithCursor([1], { Next: '' }, 'Op', 'Next'), ok({ items: [1] }));
    assert.deepEqual(
      pageWithCursor([1], { Next: 5 }, 'Op', 'Next'),
      malformed('Op', 'Next is 5; expected a string cursor'),
    );
  });

  it('reads required and optional text', () => {
    assert.deepEqual(requiredText({ A: 'x' }, 'A', 'Op'), ok('x'));
    assert.deepEqual(requiredText({ A: '' }, 'A', 'Op'), malformed('Op', 'A is ""; expected a non-empty string'));
    assert.deepEqual(requiredText({}, 'A', 'Op'), malformed('Op', 'A is absent; expected a non-empty string'));
    assert.deepEqual(optionalText({}, 'A', 'Op'), ok(undefined));
    assert.deepEqual(optionalText({ A: 'x' }, 'A', 'Op'), ok('x'));
    assert.deepEqual(optionalText({ A: 1 }, 'A', 'Op'), malformed('Op', 'A is 1; expected a non-empty string'));
  });

  it('reads an optional SDK date as an instant and refuses anything else', () => {
    assert.deepEqual(optionalInstant({ D: new Date(0) }, 'D', 'Op'), ok('1970-01-01T00:00:00.000Z'));
    assert.deepEqual(optionalInstant({}, 'D', 'Op'), ok(undefined));
    const expected = 'expected a valid instant in years 0000-9999';
    assert.deepEqual(
      optionalInstant({ D: new Date(Number.NaN) }, 'D', 'Op'),
      malformed('Op', `D is a value of type Date; ${expected}`),
    );
    assert.deepEqual(optionalInstant({ D: 0 }, 'D', 'Op'), malformed('Op', `D is 0; ${expected}`));
    assert.deepEqual(optionalInstant({ D: [] }, 'D', 'Op'), malformed('Op', `D is a list; ${expected}`));
  });

  it('reads epoch milliseconds only as safe integers within years 0000-9999', () => {
    assert.equal(instantOfMillis(0), '1970-01-01T00:00:00.000Z');
    assert.equal(instantOfMillis(Date.parse('0000-01-01T00:00:00.000Z')), '0000-01-01T00:00:00.000Z');
    assert.equal(instantOfMillis(Date.parse('9999-12-31T23:59:59.999Z')), '9999-12-31T23:59:59.999Z');
    assert.equal(instantOfMillis(Date.parse('0000-01-01T00:00:00.000Z') - 1), undefined);
    assert.equal(instantOfMillis(Date.parse('9999-12-31T23:59:59.999Z') + 1), undefined);
    for (const refused of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, '0', undefined]) {
      assert.equal(instantOfMillis(refused), undefined, String(refused));
    }
  });

  it('describes a malformed value without serializing it', () => {
    assert.deepEqual(malformedOutput('Op', 'K', undefined, 'x'), malformed('Op', 'K is absent; expected x'));
    assert.deepEqual(malformedOutput('Op', 'K', false, 'x'), malformed('Op', 'K is false; expected x'));
    assert.deepEqual(malformedOutput('Op', 'K', 10n, 'x'), malformed('Op', 'K is a value of type bigint; expected x'));
  });
});

describe('sightings', () => {
  it('builds a sighting and a creation-time member only when a time is known', () => {
    assert.deepEqual(sighting('T', 'id', 'queues', { kind: 'untaggable' }), {
      resource_type: 'T',
      identifier: 'id',
      surface: 'queues',
      tags: { kind: 'untaggable' },
    });
    const at = '2026-10-05T12:00:00.000Z' as UtcMillis;
    assert.deepEqual(createdAt(at), { created_at: at });
    assert.deepEqual(createdAt(undefined), {});
  });
});
