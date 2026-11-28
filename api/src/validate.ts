// Pure checks for submitted runs. No Cloudflare APIs here, so they are unit-tested with the game.
import { dailySeed, dayKey } from '../../src/game/daily';
import { MAX_POINTS_PER_SECOND, MAX_SPEED, RULES_VERSION, TICK_HZ } from '../../src/game/rules';

export const NAME_MAX = 12;
/** longest run accepted (ticks) */
export const MAX_TICKS = TICK_HZ * 60 * 60;
/** longest time between starting and submitting a run */
export const MAX_RUN_AGE_MS = 3 * 60 * 60 * 1000;

const NG = ['fuck', 'shit', 'nigg', 'fag', 'cunt', 'rape', 'nazi', 'hitler', 'porn', 'dick', 'pussy', 'whore', 'slut', 'retard', 'admin', 'official', 'ちんこ', 'まんこ', 'うんこ', '死ね', 'ころす'];

/** trimmed display name, or null if not allowed */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  if (chars.length < 1 || chars.length > NAME_MAX) return null;
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(s)) return null;
  const low = s.toLowerCase().replace(/[\s_.\-]/g, '');
  if (NG.some((w) => low.includes(w))) return null;
  return s;
}

export function isPlayerId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9-]{8,40}$/.test(v);
}

export function boardOf(day: string): string {
  return `daily-${day}`;
}

/** day of a daily board if it is open for submissions at `now` (today, or yesterday for runs that crossed midnight) */
export function openBoardDay(board: unknown, now: number): string | null {
  if (typeof board !== 'string') return null;
  const m = /^daily-(\d{4}-\d{2}-\d{2})$/.exec(board);
  if (!m) return null;
  const today = dayKey(new Date(now));
  const yesterday = dayKey(new Date(now - 86400000));
  return m[1] === today || m[1] === yesterday ? m[1] : null;
}

/** a readable board: any well-formed daily board */
export function isBoard(board: unknown): board is string {
  return typeof board === 'string' && /^daily-\d{4}-\d{2}-\d{2}$/.test(board);
}

export function seedOfBoard(board: string): number {
  return dailySeed(board.slice(6));
}

export interface Spawn {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface FinishBody {
  runId: string;
  board: string;
  startedAt: number;
  token: string;
  playerId: string;
  name: string;
  score: number;
  distance: number;
  ticks: number;
  bestChain: number;
  rules: number;
  spawn: Spawn;
  replay: string;
  turnstile?: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Plausibility of a finished run. Returns an error string, or null if the claim is possible.
 * (Exact checking happens offline by re-flying the replay; this rejects the impossible cheaply.)
 */
export function checkClaim(b: FinishBody, now: number): string | null {
  if (!isNum(b.score) || !isNum(b.distance) || !isNum(b.ticks) || !isNum(b.startedAt) || !isNum(b.bestChain)) return 'bad numbers';
  if (!Number.isInteger(b.score) || !Number.isInteger(b.ticks) || b.score < 0 || b.ticks < 1 || b.ticks > MAX_TICKS) return 'bad numbers';
  if (b.rules !== RULES_VERSION) return 'old version, please reload';
  const sp = b.spawn;
  if (!sp || !isNum(sp.x) || !isNum(sp.y) || !isNum(sp.z) || !isNum(sp.yaw)) return 'bad spawn';
  const seconds = b.ticks / TICK_HZ;
  const age = now - b.startedAt;
  // the countdown runs before the first tick; allow a little clock slack
  if (age < seconds * 1000 - 2000) return 'too fast';
  if (age > MAX_RUN_AGE_MS) return 'run expired';
  if (b.distance < 0 || b.distance > MAX_SPEED * seconds + 5) return 'impossible distance';
  if (b.score > Math.ceil(b.distance) + MAX_POINTS_PER_SECOND * seconds + 1000) return 'impossible score';
  if (b.bestChain < 0 || b.bestChain > b.score + 1) return 'bad chain';
  if (typeof b.replay !== 'string' || b.replay.length > 400_000 || !/^[A-Za-z0-9+/=]+$/.test(b.replay)) return 'bad replay';
  return null;
}

/** byte length of a packed replay with n ticks (see src/game/replay.ts) */
export function packedLength(n: number): number {
  return 4 + n * 2 + Math.ceil(n / 8);
}

// ---------------------------------------------------------------- run tokens (HMAC-SHA256)

function b64url(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function signRun(secret: string, runId: string, board: string, startedAt: number): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(`${runId}.${board}.${startedAt}`));
  return b64url(mac);
}

export async function checkRunToken(secret: string, runId: string, board: string, startedAt: number, token: string): Promise<boolean> {
  if (typeof token !== 'string' || typeof runId !== 'string' || runId.length > 64) return false;
  const want = await signRun(secret, runId, board, startedAt);
  if (want.length !== token.length) return false;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ token.charCodeAt(i);
  return d === 0;
}

export async function hashKey(secret: string, value: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(value));
  return b64url(mac).slice(0, 22);
}
