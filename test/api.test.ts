// The ranking Worker end to end, with its Durable Object run in-process on Node's built-in SQLite.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { localEnv, nodeState } from '../api/dev/local-store';
import worker, { type Env, RankingStore } from '../api/src/index';
import { checkClaim, cleanName, type FinishBody, openBoardDay } from '../api/src/validate';
import { dayKey } from '../src/game/daily';
import { encodeReplay } from '../src/game/replay';
import { RULES_VERSION } from '../src/game/rules';

const ORIGIN = 'https://endless-blocks.ponyo877.com';
let env: Env;
let ip = 0;

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': `10.0.0.${ip}`, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
}

const idle = { sx: 0, sy: 0, boost: 0 };

async function run(ticks: number, over: Partial<FinishBody> = {}) {
  const start = (await (await call('POST', '/v1/runs', {})).json()) as { runId: string; board: string; startedAt: number; token: string };
  const body: FinishBody = {
    runId: start.runId,
    board: start.board,
    startedAt: start.startedAt,
    token: start.token,
    playerId: 'player-0001',
    name: 'Ace',
    score: 100,
    distance: 15,
    ticks,
    bestChain: 1,
    rules: RULES_VERSION,
    spawn: { x: 1, y: 80, z: 2, yaw: 0.5 },
    replay: await encodeReplay(Array.from({ length: ticks }, () => idle)),
    ...over,
  };
  return { start, body, res: await call('POST', '/v1/runs/finish', body) };
}

beforeEach(() => {
  env = localEnv({ RUN_SECRET: 'test-secret', ADMIN_TOKEN: 'admin-token' });
  ip++;
});

describe('validate', () => {
  it('cleans names', () => {
    expect(cleanName('  Ace  Pilot ')).toBe('Ace Pilot');
    expect(cleanName('ＡＢＣ')).toBe('ABC');
    expect(cleanName('とり')).toBe('とり');
    expect(cleanName('')).toBeNull();
    expect(cleanName('a'.repeat(13))).toBeNull();
    expect(cleanName('<b>')).toBeNull();
    expect(cleanName('Ad.min')).toBeNull();
    expect(cleanName(42)).toBeNull();
  });
  it('opens today and yesterday only', () => {
    const now = Date.UTC(2026, 10, 26, 0, 30);
    expect(openBoardDay('daily-2026-11-26', now)).toBe('2026-11-26');
    expect(openBoardDay('daily-2026-11-25', now)).toBe('2026-11-25');
    expect(openBoardDay('daily-2026-11-24', now)).toBeNull();
    expect(openBoardDay('free-1', now)).toBeNull();
  });
  it('rejects impossible claims', () => {
    const now = 1_000_000_000;
    const ok: FinishBody = {
      runId: 'r', board: 'daily-x', startedAt: now - 70_000, token: 't', playerId: 'p', name: 'n',
      score: 5000, distance: 900, ticks: 3600, bestChain: 3, rules: RULES_VERSION, spawn: { x: 0, y: 0, z: 0, yaw: 0 }, replay: 'AAAA',
    };
    expect(checkClaim(ok, now)).toBeNull();
    expect(checkClaim({ ...ok, startedAt: now - 30_000 }, now)).toBe('too fast');
    expect(checkClaim({ ...ok, distance: 1e6 }, now)).toBe('impossible distance');
    expect(checkClaim({ ...ok, score: 1e9 }, now)).toBe('impossible score');
    expect(checkClaim({ ...ok, rules: 0 }, now)).toMatch(/version/);
    expect(checkClaim({ ...ok, score: 1.5 }, now)).toBe('bad numbers');
    expect(checkClaim({ ...ok, replay: 'not base64!' }, now)).toBe('bad replay');
  });
});

describe('ranking api', () => {
  it('starts and finishes a run, then lists it', async () => {
    const { start, res } = await run(60);
    expect(start.board).toBe(`daily-${dayKey()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await res.json()).toMatchObject({ rank: 1, total: 1, best: 100, improved: true });

    const list = (await (await call('GET', `/v1/boards/${start.board}?limit=5`)).json()) as { total: number; entries: { name: string; score: number; rank: number }[] };
    expect(list.total).toBe(1);
    expect(list.entries[0]).toMatchObject({ rank: 1, name: 'Ace', score: 100 });

    const rank = await (await call('GET', `/v1/boards/${start.board}/rank?score=50`)).json();
    expect(rank).toEqual({ rank: 2, total: 1 });

    const rep = (await (await call('GET', `/v1/replays/${start.board}/player-0001`)).json()) as { ticks: number; spawn: { yaw: number } };
    expect(rep.ticks).toBe(60);
    expect(rep.spawn.yaw).toBe(0.5);
  });

  it('keeps each player best and ranks players', async () => {
    await run(60, { score: 300 });
    const lower = await run(60, { score: 200, name: 'Ace2' });
    expect(await lower.res.json()).toMatchObject({ rank: 1, best: 300, improved: false });
    const other = await run(60, { score: 250, playerId: 'player-0002', name: 'Bee' });
    expect(await other.res.json()).toMatchObject({ rank: 2, total: 2 });
    const list = (await (await call('GET', `/v1/boards/${lower.start.board}`)).json()) as { entries: { name: string; score: number }[] };
    expect(list.entries.map((e) => [e.name, e.score])).toEqual([['Ace2', 300], ['Bee', 250]]);
  });

  it('rejects reused, forged, early and impossible runs', async () => {
    const first = await run(60);
    expect(first.res.status).toBe(200);
    expect((await call('POST', '/v1/runs/finish', first.body)).status).toBe(409);
    expect((await run(60, { token: 'forged' })).res.status).toBe(403);
    expect((await run(60, { startedAt: Date.now() - 1 })).res.status).toBe(403); // token covers the start time
    expect((await run(600)).res.status).toBe(400); // 10 s of flight submitted at once
    expect((await run(60, { score: 1e8 })).res.status).toBe(400);
    expect((await run(60, { name: 'fuck' })).res.status).toBe(400);
    expect((await run(60, { ticks: 120 })).res.status).toBe(400); // replay length does not match
    expect((await run(60, { board: 'daily-2001-01-01' })).res.status).toBe(400);
  });

  it('limits submissions per client', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await run(60)).res.status);
    expect(codes.slice(0, 12).every((c) => c === 200 || c === 409)).toBe(true);
    expect(codes.slice(12)).toEqual([429, 429]);
  });

  it('lets only the admin verify or hide entries', async () => {
    const { start } = await run(60);
    const target = { board: start.board, playerId: 'player-0001', verified: -1 };
    expect((await call('POST', '/v1/admin/verify', target, { authorization: 'Bearer nope' })).status).toBe(403);
    expect((await call('POST', '/v1/admin/verify', target, { authorization: 'Bearer admin-token' })).status).toBe(200);
    const list = (await (await call('GET', `/v1/boards/${start.board}`)).json()) as { total: number };
    expect(list.total).toBe(0);
  });

  it('starts runs without waking the store', async () => {
    env = { ...env, STORE: { idFromName: (n: string) => n, get: () => { throw new Error('store touched'); } } };
    const res = await call('POST', '/v1/runs', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('token');
    expect((await call('OPTIONS', '/v1/runs/finish')).status).toBe(204);
  });

  it('keeps the tables when the object restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eb-store-'));
    const file = join(dir, 'store.sqlite');
    try {
      env = localEnv({ RUN_SECRET: 'test-secret' }, file);
      const { start } = await run(60, { score: 77 });
      const again = new RankingStore(nodeState(file), { RUN_SECRET: 'test-secret' });
      const res = await again.fetch(new Request(`https://api.test/v1/boards/${start.board}`));
      expect(await res.json()).toMatchObject({ total: 1, entries: [{ score: 77 }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers CORS only for known origins', async () => {
    const pre = await call('OPTIONS', '/v1/runs', undefined, { origin: 'http://localhost:5173' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const evil = await call('GET', '/v1/boards/daily-2026-01-01', undefined, { origin: 'https://evil.example' });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });
});
