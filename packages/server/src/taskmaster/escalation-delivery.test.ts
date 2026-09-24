/**
 * Unit tests for the Taskmaster escalation-delivery module
 * (WO-HARNESS-TASKMASTER-ESCALATE-TO-ISSUE-01). Everything is
 * dependency-injected (fake comment store, fake clock); no network. The
 * delivery-claim tests use the REAL database-backed claim on a temp SQLite
 * file (two adapters on one file model two processes sharing the DB).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import {
  TASKMASTER_ESCALATION_MARKER,
  TASKMASTER_ESCALATION_COOLDOWN_MS,
  ESCALATION_COMMENT_MAX_PAGES,
  ESCALATION_TITLE_MAX_CHARS,
  buildEscalationCommentBody,
  createDbEscalationDeliveryClaim,
  createRealEscalationDeliveryDeps,
  deliverEscalationToIssue,
  escalationClaimLeaseMs,
  escalationIssueKey,
  isValidGithubLogin,
  parseGithubThreadRef,
  parseNextLink,
  parseOwnerLabel,
  resolveEscalateToIssueEnabled,
  sanitizeExternalText,
  type EscalationDeliveryDeps,
  type EscalationIssueComment,
  type EscalationIssueRef,
} from './escalation-delivery';

const ISSUE: EscalationIssueRef = { owner: 'thinmansoftware', repo: 'bdc-harness', number: 194 };
const T0 = Date.parse('2026-09-23T12:00:00.000Z');

// Non-ASCII test inputs built from char codes so this source file stays
// ASCII-only (the formatter rewrites \u escapes into literal characters).
const E_ACUTE = String.fromCharCode(0xe9);
const EM_DASH = String.fromCharCode(0x2014);
const RIGHT_ARROW = String.fromCharCode(0x2192);
const SNOWMAN = String.fromCharCode(0x2603);

describe('parseGithubThreadRef', () => {
  test('parses gh:owner/repo#N with owner and repo split', () => {
    expect(parseGithubThreadRef('gh:thinmansoftware/bdc-harness#194')).toEqual({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      number: 194,
    });
  });

  test('rejects non-gh and malformed refs', () => {
    expect(parseGithubThreadRef('dispatch:ruling-42')).toBeNull();
    expect(parseGithubThreadRef('gh:no-repo#1')).toBeNull();
    expect(parseGithubThreadRef('gh:owner/repo#0')).toBeNull();
    expect(parseGithubThreadRef('gh:owner/repo')).toBeNull();
    expect(parseGithubThreadRef('')).toBeNull();
  });
});

describe('resolveEscalateToIssueEnabled', () => {
  test('defaults to true when unset', () => {
    expect(resolveEscalateToIssueEnabled(undefined)).toBe(true);
  });

  test("only literal 'false' (any case, trimmed) disables", () => {
    expect(resolveEscalateToIssueEnabled('false')).toBe(false);
    expect(resolveEscalateToIssueEnabled('FALSE')).toBe(false);
    expect(resolveEscalateToIssueEnabled('  False  ')).toBe(false);
  });

  test('anything else keeps it enabled', () => {
    expect(resolveEscalateToIssueEnabled('true')).toBe(true);
    expect(resolveEscalateToIssueEnabled('1')).toBe(true);
    expect(resolveEscalateToIssueEnabled('')).toBe(true);
  });
});

describe('parseOwnerLabel', () => {
  test('extracts login from an owner:<login> label', () => {
    expect(parseOwnerLabel(JSON.stringify(['wo', 'P0', 'owner:major-build']))).toBe('major-build');
  });

  test('returns null when absent, empty, or malformed', () => {
    expect(parseOwnerLabel(JSON.stringify(['wo', 'P0']))).toBeNull();
    expect(parseOwnerLabel(JSON.stringify(['owner:']))).toBeNull();
    expect(parseOwnerLabel('not json')).toBeNull();
    expect(parseOwnerLabel(null)).toBeNull();
    expect(parseOwnerLabel(undefined)).toBeNull();
  });

  test("rejects 'owner:user @team' (not a single login) -> no mention", () => {
    expect(parseOwnerLabel(JSON.stringify(['owner:user @team']))).toBeNull();
  });

  test('rejects an owner label containing a newline -> no mention', () => {
    expect(parseOwnerLabel(JSON.stringify(['owner:user\n@evil']))).toBeNull();
    expect(parseOwnerLabel(JSON.stringify(['owner:user\nInjected line']))).toBeNull();
  });

  test('rejects hyphen-edged, double-hyphen, punctuated, and over-length logins', () => {
    expect(parseOwnerLabel(JSON.stringify(['owner:-user']))).toBeNull();
    expect(parseOwnerLabel(JSON.stringify(['owner:user-']))).toBeNull();
    expect(parseOwnerLabel(JSON.stringify(['owner:us--er']))).toBeNull();
    expect(parseOwnerLabel(JSON.stringify(['owner:user.name']))).toBeNull();
    expect(parseOwnerLabel(JSON.stringify([`owner:${'a'.repeat(40)}`]))).toBeNull();
    expect(parseOwnerLabel(JSON.stringify([`owner:${'a'.repeat(39)}`]))).toBe('a'.repeat(39));
  });

  test('skips an invalid owner label and takes the first valid one', () => {
    expect(parseOwnerLabel(JSON.stringify(['owner:user @team', 'owner:major-build']))).toBe(
      'major-build'
    );
  });
});

describe('isValidGithubLogin', () => {
  test('accepts single logins and rejects everything else', () => {
    expect(isValidGithubLogin('a')).toBe(true);
    expect(isValidGithubLogin('major-build')).toBe(true);
    expect(isValidGithubLogin('')).toBe(false);
    expect(isValidGithubLogin('user @team')).toBe(false);
    expect(isValidGithubLogin('@user')).toBe(false);
    expect(isValidGithubLogin(null)).toBe(false);
  });
});

describe('sanitizeExternalText', () => {
  test('strips newlines, non-ASCII, @, and angle brackets; collapses whitespace', () => {
    const raw = `  caf${E_ACUTE} ${EM_DASH} ping @team\n\tnow <!-- x -->  `;
    expect(sanitizeExternalText(raw, 100)).toBe('caf ping team now !-- x --');
  });

  test('caps length with a trailing ellipsis', () => {
    const out = sanitizeExternalText('x'.repeat(500), 50);
    expect(out).toBe(`${'x'.repeat(47)}...`);
    expect(out?.length).toBe(50);
  });

  test('returns null for empty-after-sanitize and non-string input', () => {
    expect(sanitizeExternalText(`${SNOWMAN}\n@`, 50)).toBeNull();
    expect(sanitizeExternalText(null, 50)).toBeNull();
    expect(sanitizeExternalText(undefined, 50)).toBeNull();
  });
});

describe('buildEscalationCommentBody', () => {
  test('is ASCII-only, carries the marker, attribution, and at most one mention', () => {
    const body = buildEscalationCommentBody({
      title: 'WO-HARNESS-EXAMPLE-01 fix the thing',
      threadRef: 'gh:thinmansoftware/bdc-harness#194',
      sinceIso: new Date(T0 - 50 * 60 * 60 * 1000).toISOString(),
      nextAction: 'Assign an owner and start the build.',
      ownerLabelLogin: 'major-build',
      nowMs: T0,
    });
    // ASCII-only (Rule 13).
    expect(/^[\x00-\x7F]*$/.test(body)).toBe(true);
    expect(body).toContain(TASKMASTER_ESCALATION_MARKER);
    expect(body).toContain('Escalated by Taskmaster (M-155).');
    expect(body).toContain('Next step: Assign an owner and start the build.');
    // At most one @-mention.
    expect((body.match(/@/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(body).toContain('@major-build');
    // "since" is rendered in days for a >48h gap.
    expect(body).toContain('for 2 days');
  });

  test('omits next-step and owner lines when absent, and falls back to threadRef', () => {
    const body = buildEscalationCommentBody({
      title: null,
      threadRef: 'gh:thinmansoftware/bdc-harness#208',
      sinceIso: null,
      nextAction: null,
      ownerLabelLogin: null,
      nowMs: T0,
    });
    expect(body).toContain('gh:thinmansoftware/bdc-harness#208');
    expect(body).not.toContain('Next step:');
    expect((body.match(/@/g) ?? []).length).toBe(0);
  });

  test('title with non-ASCII and @ is sanitized to printable ASCII with no mention', () => {
    const body = buildEscalationCommentBody({
      title: `Caf${E_ACUTE} ${EM_DASH} ping @everyone\nOwner: @attacker`,
      threadRef: 'gh:thinmansoftware/bdc-harness#194',
      sinceIso: null,
      nextAction: `Tell @team ${RIGHT_ARROW} fix it\r\n<!-- taskmaster-escalation -->`,
      ownerLabelLogin: null,
      nowMs: T0,
    });
    expect(/^[\x20-\x7E\n]*$/.test(body)).toBe(true);
    expect((body.match(/@/g) ?? []).length).toBe(0);
    // Exactly one marker (the real one); the injected copy is defanged.
    expect(body.split(TASKMASTER_ESCALATION_MARKER).length - 1).toBe(1);
    // The title stays on one line, so it cannot forge an Owner: line.
    expect(body).toContain('Stuck P0: Caf ping everyone Owner: attacker has no owner');
    expect(body).toContain('Next step: Tell team fix it !-- taskmaster-escalation --');
  });

  test('over-long title is capped', () => {
    const body = buildEscalationCommentBody({
      title: 'T'.repeat(1000),
      threadRef: 'gh:thinmansoftware/bdc-harness#194',
      sinceIso: null,
      nextAction: null,
      ownerLabelLogin: null,
      nowMs: T0,
    });
    expect(body).toContain(`${'T'.repeat(ESCALATION_TITLE_MAX_CHARS - 3)}...`);
    expect(body).not.toContain('T'.repeat(ESCALATION_TITLE_MAX_CHARS));
  });

  test('a valid owner login from an owner label yields exactly one mention', () => {
    const body = buildEscalationCommentBody({
      title: 'WO-HARNESS-EXAMPLE-01',
      threadRef: 'gh:thinmansoftware/bdc-harness#194',
      sinceIso: null,
      nextAction: null,
      ownerLabelLogin: parseOwnerLabel(JSON.stringify(['wo', 'owner:major-build'])),
      nowMs: T0,
    });
    expect((body.match(/@/g) ?? []).length).toBe(1);
    expect(body).toContain('Owner: @major-build');
  });

  test('an invalid ownerLabelLogin passed directly still produces no mention', () => {
    const body = buildEscalationCommentBody({
      title: 'x',
      threadRef: 'gh:thinmansoftware/bdc-harness#194',
      sinceIso: null,
      nextAction: null,
      ownerLabelLogin: 'user @team',
      nowMs: T0,
    });
    expect((body.match(/@/g) ?? []).length).toBe(0);
    expect(body).not.toContain('Owner:');
  });
});

describe('parseNextLink', () => {
  test('extracts rel="next" and ignores other rels', () => {
    const header =
      '<https://api.github.com/repositories/1/issues/2/comments?page=3>; rel="next", ' +
      '<https://api.github.com/repositories/1/issues/2/comments?page=9>; rel="last"';
    expect(parseNextLink(header)).toBe(
      'https://api.github.com/repositories/1/issues/2/comments?page=3'
    );
    expect(
      parseNextLink(
        '<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=9>; rel="last"'
      )
    ).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});

/**
 * Fake GitHub issue-comments endpoint: oldest-first, 100 per page, Link
 * rel="next" pagination. Deliberately IGNORES `since`, so the tests prove the
 * pagination alone finds a marker past comment #100.
 */
function fakeGithubComments(comments: EscalationIssueComment[]): {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  gets: string[];
  posts: string[];
} {
  const gets: string[] = [];
  const posts: string[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if ((init?.method ?? 'GET') === 'POST') {
      posts.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }
    gets.push(input);
    const perPage = Number(url.searchParams.get('per_page') ?? '30');
    const page = Number(url.searchParams.get('page') ?? '1');
    const slice = comments.slice((page - 1) * perPage, page * perPage);
    const headers = new Headers({ 'content-type': 'application/json' });
    if (page * perPage < comments.length) {
      const next = new URL(url.toString());
      next.searchParams.set('page', String(page + 1));
      headers.set('link', `<${next.toString()}>; rel="next"`);
    }
    return new Response(JSON.stringify(slice), { status: 200, headers });
  };
  return { fetchImpl, gets, posts };
}

describe('deliverEscalationToIssue', () => {
  test('no prior marker comment -> posts and returns posted:true', async () => {
    const nowMs = T0;
    let posts = 0;
    const comments: EscalationIssueComment[] = [
      { body: 'a human comment', created_at: new Date(T0 - 1000).toISOString() },
    ];
    const deps = {
      listIssueComments: async () => comments,
      postIssueComment: async (_i: EscalationIssueRef, body: string) => {
        posts += 1;
        comments.push({ body, created_at: new Date(nowMs).toISOString() });
      },
      now: () => new Date(nowMs),
    };
    const result = await deliverEscalationToIssue(
      {
        issue: ISSUE,
        threadRef: 'gh:thinmansoftware/bdc-harness#194',
        body: `${TASKMASTER_ESCALATION_MARKER}\n\nbody`,
      },
      deps
    );
    expect(result.posted).toBe(true);
    expect(posts).toBe(1);
  });

  test('prior marker comment younger than 72h -> does not post', async () => {
    const nowMs = T0;
    let posts = 0;
    const comments: EscalationIssueComment[] = [
      {
        body: `${TASKMASTER_ESCALATION_MARKER}\n\nprevious escalation`,
        created_at: new Date(T0 - (TASKMASTER_ESCALATION_COOLDOWN_MS - 60_000)).toISOString(),
      },
    ];
    const deps = {
      listIssueComments: async () => comments,
      postIssueComment: async () => {
        posts += 1;
      },
      now: () => new Date(nowMs),
    };
    const result = await deliverEscalationToIssue(
      { issue: ISSUE, threadRef: 'gh:thinmansoftware/bdc-harness#194', body: 'x' },
      deps
    );
    expect(result.posted).toBe(false);
    expect(posts).toBe(0);
  });

  test('prior marker comment older than 72h -> posts again', async () => {
    const nowMs = T0;
    let posts = 0;
    const comments: EscalationIssueComment[] = [
      {
        body: `${TASKMASTER_ESCALATION_MARKER}\n\nstale escalation`,
        created_at: new Date(T0 - (TASKMASTER_ESCALATION_COOLDOWN_MS + 60_000)).toISOString(),
      },
    ];
    const deps = {
      listIssueComments: async () => comments,
      postIssueComment: async () => {
        posts += 1;
      },
      now: () => new Date(nowMs),
    };
    const result = await deliverEscalationToIssue(
      { issue: ISSUE, threadRef: 'gh:thinmansoftware/bdc-harness#194', body: 'x' },
      deps
    );
    expect(result.posted).toBe(true);
    expect(posts).toBe(1);
  });

  test('passes the cooldown-window start to listIssueComments', async () => {
    let seenSince: string | undefined;
    await deliverEscalationToIssue(
      { issue: ISSUE, threadRef: 'gh:thinmansoftware/bdc-harness#194', body: 'x' },
      {
        listIssueComments: async (_i, sinceIso) => {
          seenSince = sinceIso;
          return [];
        },
        postIssueComment: async () => {},
        now: () => new Date(T0),
      }
    );
    expect(seenSince).toBe(new Date(T0 - TASKMASTER_ESCALATION_COOLDOWN_MS).toISOString());
  });
});

describe('createRealEscalationDeliveryDeps (fake fetch)', () => {
  test('>100 comments with the only marker recent (#141 of 150) -> no new comment posted', async () => {
    const comments: EscalationIssueComment[] = [];
    for (let i = 0; i < 150; i += 1) {
      comments.push({
        body: `human comment ${i}`,
        created_at: new Date(T0 - (400 - i) * 60 * 60 * 1000).toISOString(),
      });
    }
    comments[140] = {
      body: `${TASKMASTER_ESCALATION_MARKER}\n\nrecent escalation`,
      created_at: new Date(T0 - 60 * 60 * 1000).toISOString(),
    };
    const fake = fakeGithubComments(comments);
    const deps = {
      ...createRealEscalationDeliveryDeps({ fetchImpl: fake.fetchImpl, token: 'test-token' }),
      now: () => new Date(T0),
    };
    const result = await deliverEscalationToIssue(
      { issue: ISSUE, threadRef: 'gh:thinmansoftware/bdc-harness#194', body: 'x' },
      deps
    );
    expect(result.posted).toBe(false);
    expect(fake.posts.length).toBe(0);
    // Both pages were read, and the first request asked for the cooldown window.
    expect(fake.gets.length).toBe(2);
    const first = new URL(fake.gets[0]);
    expect(first.searchParams.get('per_page')).toBe('100');
    expect(first.searchParams.get('since')).toBe(
      new Date(T0 - TASKMASTER_ESCALATION_COOLDOWN_MS).toISOString()
    );
  });

  test('>100 comments with no marker -> reads every page and posts exactly once', async () => {
    const comments: EscalationIssueComment[] = [];
    for (let i = 0; i < 250; i += 1) {
      comments.push({ body: `c${i}`, created_at: new Date(T0 - 1000).toISOString() });
    }
    const fake = fakeGithubComments(comments);
    const deps = {
      ...createRealEscalationDeliveryDeps({ fetchImpl: fake.fetchImpl, token: 'test-token' }),
      now: () => new Date(T0),
    };
    const result = await deliverEscalationToIssue(
      { issue: ISSUE, threadRef: 'gh:thinmansoftware/bdc-harness#194', body: 'hello' },
      deps
    );
    expect(result.posted).toBe(true);
    expect(fake.gets.length).toBe(3);
    expect(fake.posts).toEqual([JSON.stringify({ body: 'hello' })]);
  });

  test('refuses to follow a next link off api.github.com (token never leaves)', async () => {
    const requested: string[] = [];
    const fetchImpl = async (input: string): Promise<Response> => {
      requested.push(input);
      return new Response(JSON.stringify([{ body: 'c', created_at: new Date(T0).toISOString() }]), {
        status: 200,
        headers: { link: '<https://evil.example.com/steal?page=2>; rel="next"' },
      });
    };
    const deps = createRealEscalationDeliveryDeps({ fetchImpl, token: 'test-token' });
    await expect(deps.listIssueComments(ISSUE)).rejects.toThrow(
      'taskmaster_github_url_not_api_origin'
    );
    expect(requested.length).toBe(1);
  });

  test('fails closed (throws, no post) when the page ceiling is reached', async () => {
    let gets = 0;
    let posts = 0;
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      if ((init?.method ?? 'GET') === 'POST') {
        posts += 1;
        return new Response('{}', { status: 201 });
      }
      gets += 1;
      const next = new URL(input);
      next.searchParams.set('page', String(gets + 1));
      return new Response(JSON.stringify([{ body: 'c', created_at: new Date(T0).toISOString() }]), {
        status: 200,
        headers: { link: `<${next.toString()}>; rel="next"` },
      });
    };
    const deps = {
      ...createRealEscalationDeliveryDeps({ fetchImpl, token: 'test-token' }),
      now: () => new Date(T0),
    };
    await expect(
      deliverEscalationToIssue(
        { issue: ISSUE, threadRef: 'gh:thinmansoftware/bdc-harness#194', body: 'x' },
        deps
      )
    ).rejects.toThrow('taskmaster_github_comment_pages_exceeded');
    expect(gets).toBe(ESCALATION_COMMENT_MAX_PAGES);
    expect(posts).toBe(0);
  });
});

describe('per-issue delivery claim (tm_escalation_claims, real SQLite)', () => {
  const ISSUE_B: EscalationIssueRef = {
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    number: 195,
  };
  let dbPath = '';
  let processA: SqliteAdapter;
  let processB: SqliteAdapter;

  beforeEach(() => {
    dbPath = join(tmpdir(), `escalation-claim-${Date.now()}-${Math.random()}.db`);
    // Two adapters on ONE file: two Taskmaster processes sharing the database.
    processA = new SqliteAdapter(dbPath);
    processB = new SqliteAdapter(dbPath);
  });

  afterEach(async () => {
    await processA.close();
    await processB.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(dbPath + suffix);
      } catch {
        /* file may not exist */
      }
    }
  });

  /**
   * Fake GitHub shared by both "processes". listIssueComments yields to the
   * event loop before answering, so two unserialized deliveries BOTH see no
   * marker -- the exact list-then-post race the claim exists to close.
   */
  function sharedGithub(): {
    posts: EscalationIssueRef[];
    deps: (clock: () => number) => EscalationDeliveryDeps;
  } {
    const byIssue = new Map<string, EscalationIssueComment[]>();
    const posts: EscalationIssueRef[] = [];
    return {
      posts,
      deps: clock => ({
        listIssueComments: async issue => {
          // Read now, answer later: a concurrent caller reads the same state.
          const snapshot = [...(byIssue.get(escalationIssueKey(issue)) ?? [])];
          await new Promise(resolve => setTimeout(resolve, 5));
          return snapshot;
        },
        postIssueComment: async (issue, body) => {
          posts.push(issue);
          const list = byIssue.get(escalationIssueKey(issue)) ?? [];
          list.push({ body, created_at: new Date(clock()).toISOString() });
          byIssue.set(escalationIssueKey(issue), list);
        },
        now: () => new Date(clock()),
      }),
    };
  }

  function params(issue: EscalationIssueRef): {
    issue: EscalationIssueRef;
    threadRef: string;
    body: string;
  } {
    return {
      issue,
      threadRef: `gh:${issue.owner}/${issue.repo}#${issue.number}`,
      body: `${TASKMASTER_ESCALATION_MARKER}\n\nbody`,
    };
  }

  test('control: without a claim, two concurrent deliveries both post (the race is real)', async () => {
    const gh = sharedGithub();
    const clock = (): number => T0;
    const results = await Promise.all([
      deliverEscalationToIssue(params(ISSUE), gh.deps(clock)),
      deliverEscalationToIssue(params(ISSUE), gh.deps(clock)),
    ]);
    expect(results.every(r => r.posted)).toBe(true);
    expect(gh.posts).toHaveLength(2);
  });

  test('two concurrent deliveries for the same issue from two processes -> exactly one post', async () => {
    const gh = sharedGithub();
    const clock = (): number => T0;
    const results = await Promise.all([
      deliverEscalationToIssue(params(ISSUE), {
        ...gh.deps(clock),
        claim: createDbEscalationDeliveryClaim(processA),
      }),
      deliverEscalationToIssue(params(ISSUE), {
        ...gh.deps(clock),
        claim: createDbEscalationDeliveryClaim(processB),
      }),
    ]);
    expect(gh.posts).toHaveLength(1);
    expect(results.filter(r => r.posted)).toHaveLength(1);
    expect(results.find(r => !r.posted)?.suppressedBy).toBe('claim_held');
  });

  test('a crashed attempt holds the issue only until its lease expires', async () => {
    const gh = sharedGithub();
    let nowMs = T0;
    const clock = (): number => nowMs;
    // Process A claims and "crashes": no list, no post, no release.
    const crashed = await createDbEscalationDeliveryClaim(processA).claim(
      escalationIssueKey(ISSUE),
      T0
    );
    expect(crashed).not.toBeNull();

    // Inside the lease: process B must not post.
    nowMs = T0 + 60_000;
    const blocked = await deliverEscalationToIssue(params(ISSUE), {
      ...gh.deps(clock),
      claim: createDbEscalationDeliveryClaim(processB),
    });
    expect(blocked).toEqual({ posted: false, suppressedBy: 'claim_held' });
    expect(gh.posts).toHaveLength(0);

    // After the lease: the next attempt claims and posts.
    nowMs = T0 + escalationClaimLeaseMs() + 1;
    const recovered = await deliverEscalationToIssue(params(ISSUE), {
      ...gh.deps(clock),
      claim: createDbEscalationDeliveryClaim(processB),
    });
    expect(recovered.posted).toBe(true);
    expect(gh.posts).toHaveLength(1);
  });

  test('different issues are not serialized against each other', async () => {
    const gh = sharedGithub();
    const clock = (): number => T0;
    const results = await Promise.all([
      deliverEscalationToIssue(params(ISSUE), {
        ...gh.deps(clock),
        claim: createDbEscalationDeliveryClaim(processA),
      }),
      deliverEscalationToIssue(params(ISSUE_B), {
        ...gh.deps(clock),
        claim: createDbEscalationDeliveryClaim(processB),
      }),
    ]);
    expect(results.every(r => r.posted)).toBe(true);
    expect(gh.posts.map(i => i.number).sort()).toEqual([194, 195]);
  });

  test('a posted claim holds for the cooldown even if the marker is not listed yet', async () => {
    let nowMs = T0;
    let posts = 0;
    // GitHub listing that never shows the comment (e.g. read-after-write lag).
    const blindGithub: EscalationDeliveryDeps = {
      listIssueComments: async () => [],
      postIssueComment: async () => {
        posts += 1;
      },
      now: () => new Date(nowMs),
      claim: createDbEscalationDeliveryClaim(processA),
    };
    expect((await deliverEscalationToIssue(params(ISSUE), blindGithub)).posted).toBe(true);
    nowMs = T0 + escalationClaimLeaseMs() + 60_000;
    expect(await deliverEscalationToIssue(params(ISSUE), blindGithub)).toEqual({
      posted: false,
      suppressedBy: 'claim_held',
    });
    nowMs = T0 + TASKMASTER_ESCALATION_COOLDOWN_MS;
    expect((await deliverEscalationToIssue(params(ISSUE), blindGithub)).posted).toBe(true);
    expect(posts).toBe(2);
  });

  test('marker suppression and a failed post both release the claim immediately', async () => {
    const claim = createDbEscalationDeliveryClaim(processA);
    const suppressedByMarker = await deliverEscalationToIssue(params(ISSUE), {
      listIssueComments: async () => [
        { body: TASKMASTER_ESCALATION_MARKER, created_at: new Date(T0 - 60_000).toISOString() },
      ],
      postIssueComment: async () => {},
      now: () => new Date(T0),
      claim,
    });
    expect(suppressedByMarker).toEqual({ posted: false, suppressedBy: 'cooldown_marker' });
    // Released: a fresh claim succeeds at once (no lease wait).
    const probe = await claim.claim(escalationIssueKey(ISSUE), T0 + 1);
    expect(probe).not.toBeNull();
    await claim.release(escalationIssueKey(ISSUE), probe as string);

    await expect(
      deliverEscalationToIssue(params(ISSUE), {
        listIssueComments: async () => [],
        postIssueComment: async () => {
          throw new Error('github_down');
        },
        now: () => new Date(T0 + 2),
        claim,
      })
    ).rejects.toThrow('github_down');
    expect(await claim.claim(escalationIssueKey(ISSUE), T0 + 3)).not.toBeNull();
  });
});
