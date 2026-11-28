// Ranking API for Endless Blocks: Skim (Cloudflare Worker + one SQLite-backed Durable Object).
//
//   POST /v1/runs                     start a run on today's board -> { runId, startedAt, token }
//   POST /v1/runs/finish              submit a finished run -> { rank, total, best }
//   GET  /v1/boards/:board?limit=N    top scores
//   GET  /v1/boards/:board/rank?score=N
//   GET  /v1/replays/:board/:playerId input log of a ranked run (for offline re-flying)
//   POST /v1/admin/verify             { board, playerId, verified: 1 | -1 }   (Bearer ADMIN_TOKEN)
//   POST /v1/admin/delete             { board, playerId }                     (Bearer ADMIN_TOKEN)
//
// The Worker answers preflights and run starts itself (they need no storage) and hands every
// other request to the RankingStore Durable Object, which keeps the tables (see store.ts).
import {
  type FinishBody, boardOf, checkClaim, checkRunToken, cleanName, hashKey, isBoard, isPlayerId, openBoardDay, packedLength, seedOfBoard, signRun,
} from './validate';
import { dayKey } from '../../src/game/daily';
import { type Db, type StoreState, sqlDb } from './store';

/** secrets and settings, shared by the Worker and the Durable Object */
export interface Config {
  /** HMAC key for run tokens and client hashes */
  RUN_SECRET: string;
  ADMIN_TOKEN?: string;
  TURNSTILE_SECRET?: string;
  /** comma-separated origins allowed to call the API */
  ALLOWED_ORIGINS?: string;
}

/** the Durable Object namespace binding (structural, so tests can stand in for it) */
interface StoreNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

export interface Env extends Config {
  STORE: StoreNamespace;
}

const DEFAULT_ORIGINS = 'https://endless-blocks.ponyo877.com,http://localhost:5173,http://localhost:4173';
/** submissions per client per minute */
const RATE = 12;
const KEEP_REPLAYS = 100;

function cors(req: Request, env: Config): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(',').map((s) => s.trim());
  const h: Record<string, string> = { vary: 'origin' };
  if (allowed.includes(origin)) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    h['access-control-allow-headers'] = 'content-type';
    h['access-control-max-age'] = '86400';
  }
  return h;
}

function json(data: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

async function body<T>(req: Request): Promise<T | null> {
  try {
    const text = await req.text();
    if (text.length > 500_000) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function gunzipLength(b64: string): Promise<number> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return buf.byteLength;
}

async function turnstileOk(env: Config, token: string | undefined, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const d = (await r.json()) as { success?: boolean };
  return !!d.success;
}

async function rateLimited(env: Config, db: Db, ip: string, now: number): Promise<boolean> {
  const minute = Math.floor(now / 60000);
  const key = await hashKey(env.RUN_SECRET, `${ip}|${minute}`);
  const row = db.get<{ n: number }>(
    'INSERT INTO hits (key, n, until) VALUES (?1, 1, ?2) ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n',
    key, now + 120000,
  );
  return (row?.n ?? 0) > RATE;
}

function rankOf(db: Db, board: string, score: number): { rank: number; total: number } {
  const r = db.get<{ above: number; total: number }>(
    'SELECT (SELECT COUNT(*) FROM scores WHERE board = ?1 AND verified >= 0 AND score > ?2) AS above, (SELECT COUNT(*) FROM scores WHERE board = ?1 AND verified >= 0) AS total',
    board, score,
  );
  return { rank: (r?.above ?? 0) + 1, total: r?.total ?? 0 };
}

async function startRun(req: Request, env: Config, h: Record<string, string>): Promise<Response> {
  const b = await body<{ board?: string }>(req);
  const now = Date.now();
  // a page opened before midnight may still start a run on yesterday's board
  const board = b?.board ?? boardOf(dayKey(new Date(now)));
  if (!openBoardDay(board, now)) return json({ error: 'board closed' }, 400, h);
  const runId = crypto.randomUUID();
  const token = await signRun(env.RUN_SECRET, runId, board, now);
  return json({ runId, board, startedAt: now, token, seed: seedOfBoard(board) }, 200, h);
}

async function finishRun(req: Request, env: Config, db: Db, h: Record<string, string>): Promise<Response> {
  const now = Date.now();
  const ip = req.headers.get('cf-connecting-ip') ?? '';
  const b = await body<FinishBody>(req);
  if (!b) return json({ error: 'bad request' }, 400, h);
  if (await rateLimited(env, db, ip, now)) return json({ error: 'slow down' }, 429, h);
  if (!openBoardDay(b.board, now)) return json({ error: 'board closed' }, 400, h);
  if (!(await checkRunToken(env.RUN_SECRET, b.runId, b.board, b.startedAt, b.token))) return json({ error: 'bad token' }, 403, h);
  const name = cleanName(b.name);
  if (!name) return json({ error: 'name not allowed' }, 400, h);
  if (!isPlayerId(b.playerId)) return json({ error: 'bad player' }, 400, h);
  const bad = checkClaim(b, now);
  if (bad) return json({ error: bad }, 400, h);
  try {
    if ((await gunzipLength(b.replay)) !== packedLength(b.ticks)) return json({ error: 'replay does not match' }, 400, h);
  } catch {
    return json({ error: 'bad replay' }, 400, h);
  }
  if (!(await turnstileOk(env, b.turnstile, ip))) return json({ error: 'verification failed' }, 403, h);

  // From here on nothing awaits, so the object runs the rest of the submission without interleaving.
  // single use
  const fresh = db.get('INSERT OR IGNORE INTO used_runs (run_id, at) VALUES (?1, ?2) RETURNING run_id', b.runId, now);
  if (!fresh) return json({ error: 'already submitted' }, 409, h);

  const prev = db.get<{ score: number }>('SELECT score FROM scores WHERE board = ?1 AND player_id = ?2', b.board, b.playerId);
  const improved = !prev || b.score > prev.score;
  if (improved) {
    db.run(
      `INSERT INTO scores (board, player_id, name, score, distance, duration_ms, best_chain, rules, created_at, verified)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)
       ON CONFLICT(board, player_id) DO UPDATE SET name = excluded.name, score = excluded.score, distance = excluded.distance,
         duration_ms = excluded.duration_ms, best_chain = excluded.best_chain, rules = excluded.rules, created_at = excluded.created_at, verified = 0`,
      b.board, b.playerId, name, b.score, Math.round(b.distance), Math.round((b.ticks * 1000) / 60), Math.floor(b.bestChain), b.rules, now,
    );
  } else {
    db.run('UPDATE scores SET name = ?3 WHERE board = ?1 AND player_id = ?2', b.board, b.playerId, name);
  }
  const best = improved ? b.score : prev!.score;
  const { rank, total } = rankOf(db, b.board, best);
  if (improved && rank <= KEEP_REPLAYS) {
    db.run(
      'INSERT OR REPLACE INTO replays (board, player_id, seed, spawn, ticks, score, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
      b.board, b.playerId, seedOfBoard(b.board), JSON.stringify(b.spawn), b.ticks, b.score, b.replay,
    );
  }
  // housekeeping now and then
  if (Math.random() < 0.02) {
    db.tx(() => {
      db.run('DELETE FROM hits WHERE until < ?1', now);
      db.run('DELETE FROM used_runs WHERE at < ?1', now - 3 * 86400000);
    });
  }
  return json({ rank, total, best, improved }, 200, h);
}

function board(db: Db, h: Record<string, string>, b: string, url: URL): Response {
  if (!isBoard(b)) return json({ error: 'no such board' }, 404, h);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
  const rows = db.all<{ playerId: string; name: string; score: number; distance: number; verified: number }>(
    'SELECT player_id AS playerId, name, score, distance, verified FROM scores WHERE board = ?1 AND verified >= 0 ORDER BY score DESC, created_at ASC LIMIT ?2',
    b, limit,
  );
  const total = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM scores WHERE board = ?1 AND verified >= 0', b);
  const entries = rows.map((e, i) => ({ rank: i + 1, ...e }));
  return json({ board: b, total: total?.n ?? 0, entries }, 200, { ...h, 'cache-control': 'public, max-age=15' });
}

async function admin(req: Request, env: Config, db: Db, h: Record<string, string>, action: string): Promise<Response> {
  const auth = req.headers.get('authorization') ?? '';
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'forbidden' }, 403, h);
  const b = await body<{ board: string; playerId: string; verified?: number }>(req);
  if (!b || !isBoard(b.board) || !isPlayerId(b.playerId)) return json({ error: 'bad request' }, 400, h);
  if (action === 'verify') {
    const v = b.verified === 1 ? 1 : -1;
    db.run('UPDATE scores SET verified = ?3 WHERE board = ?1 AND player_id = ?2', b.board, b.playerId, v);
  } else {
    db.tx(() => {
      db.run('DELETE FROM scores WHERE board = ?1 AND player_id = ?2', b.board, b.playerId);
      db.run('DELETE FROM replays WHERE board = ?1 AND player_id = ?2', b.board, b.playerId);
    });
  }
  return json({ ok: true }, 200, h);
}

/** answer a request; `db` is null in the Worker, which only handles the routes that need no storage */
export async function handle(req: Request, env: Config, db: Db | null): Promise<Response> {
  const h = cors(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  const url = new URL(req.url);
  const p = url.pathname.split('/').filter(Boolean);
  try {
    if (p[0] !== 'v1') return json({ ok: true, service: 'endless-blocks-api' }, 200, h);
    if (req.method === 'POST' && p[1] === 'runs' && p.length === 2) return await startRun(req, env, h);
    if (!db) return json({ error: 'not found' }, 404, h);
    if (req.method === 'POST' && p[1] === 'runs' && p[2] === 'finish') return await finishRun(req, env, db, h);
    if (req.method === 'GET' && p[1] === 'boards' && p.length === 3) return board(db, h, p[2], url);
    if (req.method === 'GET' && p[1] === 'boards' && p[3] === 'rank') {
      if (!isBoard(p[2])) return json({ error: 'no such board' }, 404, h);
      return json(rankOf(db, p[2], Number(url.searchParams.get('score')) || 0), 200, h);
    }
    if (req.method === 'GET' && p[1] === 'replays' && p.length === 4) {
      if (!isBoard(p[2]) || !isPlayerId(p[3])) return json({ error: 'not found' }, 404, h);
      const r = db.get<{ seed: number; spawn: string; ticks: number; score: number; data: string }>(
        'SELECT seed, spawn, ticks, score, data FROM replays WHERE board = ?1 AND player_id = ?2', p[2], p[3],
      );
      if (!r) return json({ error: 'not found' }, 404, h);
      return json({ seed: r.seed, spawn: JSON.parse(r.spawn), ticks: r.ticks, score: r.score, replay: r.data }, 200, h);
    }
    if (req.method === 'POST' && p[1] === 'admin' && (p[2] === 'verify' || p[2] === 'delete')) return await admin(req, env, db, h, p[2]);
    return json({ error: 'not found' }, 404, h);
  } catch (e) {
    console.error(e);
    return json({ error: 'server error' }, 500, h);
  }
}

/** a run start needs no storage, so the Worker answers it without waking the Durable Object */
function needsStore(req: Request): boolean {
  const { pathname } = new URL(req.url);
  if (req.method === 'OPTIONS' || !pathname.startsWith('/v1/')) return false;
  return !(req.method === 'POST' && pathname === '/v1/runs');
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    if (!needsStore(req)) return handle(req, env, null);
    return env.STORE.get(env.STORE.idFromName('ranking')).fetch(req);
  },
};

/** the one Durable Object that holds every board */
export class RankingStore {
  private readonly db: Db;
  private readonly env: Config;

  constructor(state: StoreState, env: Config) {
    this.db = sqlDb(state);
    this.env = env;
  }

  fetch(req: Request): Promise<Response> {
    return handle(req, this.env, this.db);
  }
}
