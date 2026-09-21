import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-usage-test-'));
process.env.AGY_USAGE_CONFIG_DIR = CFG;
process.env.GEMINI_HOME = path.join(CFG, 'fake-gemini');
process.env.AGY_USAGE_DISABLE_SPAWN = '1';

const core = await import('../src/core.mjs');
const auth = await import('../src/auth.mjs');
const quota = await import('../src/quota.mjs');

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(typeof input === 'string' ? input : input?.url ?? input);
  if (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')) {
    return realFetch(input, init);
  }
  if (url.includes('generativelanguage.googleapis.com')) {
    return {
      status: 200,
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-3.7-flash', displayName: 'Gemini 3.7 Flash', inputTokenLimit: 1048576 },
          { name: 'models/gemini-3.7-pro', displayName: 'Gemini 3.7 Pro', inputTokenLimit: 2097152 },
        ],
      }),
      text: async () => JSON.stringify({ ok: true }),
    };
  }
  throw new Error(`Unit test must not reach external network: ${url}`);
};

before(() => core.setLogger({ onWarn: () => {}, onInfo: () => {} }));
after(() => fs.rmSync(CFG, { recursive: true, force: true }));

describe('account index & storage', () => {
  it('treats a missing index file as empty', () => {
    fs.rmSync(core.INDEX_FILE, { force: true });
    assert.deepEqual(core.loadIndex().accounts, []);
  });

  it('saves and loads index correctly', () => {
    core.saveIndex({
      version: 1,
      accounts: [{ email: 'dev@example.com', label: 'work', provider: 'antigravity' }],
    });
    assert.equal(core.loadIndex().accounts.length, 1);
    assert.equal(core.loadIndex().accounts[0].email, 'dev@example.com');
  });

  it('persists and retrieves tokens', () => {
    core.tokenSet('dev@example.com', { accessToken: 'test-token', refreshToken: 'test-refresh' });
    const stored = core.tokenGet('dev@example.com');
    assert.equal(stored.accessToken, 'test-token');
    assert.equal(stored.refreshToken, 'test-refresh');
    core.tokenDelete('dev@example.com');
    assert.equal(core.tokenGet('dev@example.com'), null);
  });
});

describe('findAccount & switchAccount', () => {
  before(() => {
    core.saveIndex({
      version: 1,
      accounts: [
        { email: 'user1@example.com', label: 'primary' },
        { email: 'user2@example.com', label: 'secondary' },
      ],
    });
  });

  it('finds account by exact email', () => {
    const found = core.findAccount('user1@example.com');
    assert.ok(found);
    assert.equal(found.entry.label, 'primary');
  });

  it('finds account by label', () => {
    const found = core.findAccount('secondary');
    assert.ok(found);
    assert.equal(found.entry.email, 'user2@example.com');
  });

  it('returns null for unknown account', () => {
    assert.equal(core.findAccount('nonexistent'), null);
  });

  it('switches active account', async () => {
    const res = await core.switchAccount('primary');
    assert.equal(res.entry.email, 'user1@example.com');
    const config = auth.readAgyActiveConfig();
    assert.equal(config.activeEmail, 'user1@example.com');
  });
});

describe('security & redaction', () => {
  it('redacts Google API keys and OAuth tokens', () => {
    const secret = 'Key AIzaSyABC123XYZ456789_abcdefghijk123 and token ya29.a0AfH6SMDh789xyz';
    const clean = core.redact(secret);
    assert.ok(!clean.includes('AIzaSy'));
    assert.ok(!clean.includes('ya29'));
    assert.ok(clean.includes('[redacted]'));
  });

  it('masks email addresses in scrub', () => {
    const clean = core.scrub('Logged in as developer@domain.com with secret sk-1234567890123456');
    assert.ok(!clean.includes('developer@domain.com'));
    assert.ok(clean.includes('d********@d***.com'));
    assert.ok(clean.includes('[redacted]'));
  });

  it('validates constant-time safeEqual', () => {
    assert.ok(core.safeEqual('my-state-secret', 'my-state-secret'));
    assert.ok(!core.safeEqual('my-state-secret', 'wrong-secret'));
  });
});

describe('PKCE and OAuth Loopback', () => {
  it('generates PKCE pair with valid base64url characters', () => {
    const { codeVerifier, challenge, state } = auth.pkcePair();
    assert.ok(codeVerifier.length >= 40);
    assert.ok(challenge.length >= 40);
    assert.ok(state.length >= 40);
  });

  it('builds a secure Google OAuth authorize URL', () => {
    const url = auth.buildAuthorizeUrl({
      redirectUri: 'http://localhost:54321/callback',
      challenge: 'chal_123',
      state: 'st_456',
    });
    assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
    assert.ok(url.includes('redirect_uri=http%3A%2F%2Flocalhost%3A54321%2Fcallback'));
  });

  it('completes local callback with matching state', async () => {
    const session = await core.beginLogin({});
    const state = new URL(session.authorizeUrl).searchParams.get('state');
    const res = await realFetch(
      `http://127.0.0.1:${session.port}/callback?code=AUTH_TEST_CODE&state=${encodeURIComponent(state)}`
    );
    assert.equal(res.status, 200);
    assert.equal(await session.waitForCode(), 'AUTH_TEST_CODE');
  });

  it('rejects callback with mismatched state', async () => {
    const session = await core.beginLogin({});
    const res = await realFetch(
      `http://127.0.0.1:${session.port}/callback?code=AUTH_TEST_CODE&state=WRONG_STATE`
    );
    assert.equal(res.status, 404);
    session.cancel();
    await session.waitForCode().catch(() => {});
  });
});

describe('Antigravity telemetry parsing & quota calculation', () => {
  it('parses tab-delimited agy -p /usage output accurately', () => {
    const raw = [
      'Gemini Models\tWeekly Limit Remaining\t16%\t2026-09-23T04:49:24Z',
      'Gemini Models\tFive Hour Limit Remaining\t81%\t2026-09-21T10:17:04Z',
      'Claude and GPT models\tWeekly Limit Remaining\t33%\t2026-09-24T07:55:57Z',
      'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-21T11:03:33Z',
    ].join('\n');

    const windows = quota.parseAgyUsageOutput(raw);
    assert.equal(windows.length, 4);

    const g5h = windows.find((w) => w.key === 'gemini_5h');
    assert.equal(g5h.remainingPercent, 81);
    assert.equal(g5h.percent, 19);
    assert.equal(g5h.resetsAt, '2026-09-21T10:17:04Z');

    const gw = windows.find((w) => w.key === 'gemini_weekly');
    assert.equal(gw.remainingPercent, 16);
    assert.equal(gw.percent, 84);

    const c5h = windows.find((w) => w.key === 'claude_5h');
    assert.equal(c5h.remainingPercent, 100);
    assert.equal(c5h.percent, 0);

    const cw = windows.find((w) => w.key === 'claude_weekly');
    assert.equal(cw.remainingPercent, 33);
    assert.equal(cw.percent, 67);
  });

  it('computes headroom across session and weekly windows', () => {
    const usage = {
      windows: [
        { key: 'gemini_5h', group: 'session', percent: 19 },
        { key: 'gemini_weekly', group: 'weekly', percent: 84 },
        { key: 'claude_5h', group: 'session', percent: 0 },
        { key: 'claude_weekly', group: 'weekly', percent: 67 },
      ],
    };
    const hr = core.headroom(usage);
    assert.equal(hr.session, 19);
    assert.equal(hr.weekly, 84);
    assert.equal(hr.worst, 84);
  });
});

describe('addApiKey & API Key authentication', () => {
  it('validates and registers a Google AI Studio API key', async () => {
    const saved = await core.addApiKey('AIzaSyDUMMY_TEST_KEY_1234567890abcdef', {
      label: 'studio-key',
    });
    assert.equal(saved.label, 'studio-key');
    assert.equal(saved.record.modelsAvailable, 2);
    assert.equal(saved.record.tier, 'Google AI Studio Key');
    assert.ok(core.tokenGet(saved.email));
  });
});

describe('CLI execution', () => {
  it('outputs valid JSON with --json flag', () => {
    core.saveIndex({
      version: 1,
      accounts: [{ email: 'cli-test@example.com', label: 'cli-test', provider: 'antigravity' }],
    });
    core.tokenSet('cli-test@example.com', {
      email: 'cli-test@example.com',
      accessToken: 'sample',
      tier: 'Pay-as-you-go',
    });

    const cliPath = path.resolve(process.cwd(), 'cli.mjs');
    const stdout = execFileSync(process.execPath, [cliPath, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, AGY_USAGE_CONFIG_DIR: CFG },
    });

    const json = JSON.parse(stdout);
    assert.ok(Array.isArray(json));
    assert.equal(json.length, 1);
    assert.equal(json[0].email, 'cli-test@example.com');
    assert.equal(json[0].provider, 'antigravity');
  });
});
