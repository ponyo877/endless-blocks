// Client for the ranking API (api/src/index.ts). Ranking is on only when VITE_API_URL is set at build time.
import type { Spawn } from './sim';

const BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/$/, '');
const SITEKEY = (import.meta.env.VITE_TURNSTILE_SITEKEY as string | undefined) ?? '';
export const rankingEnabled = BASE !== '';

export interface Ticket {
  runId: string;
  board: string;
  startedAt: number;
  token: string;
}

export interface BoardEntry {
  rank: number;
  playerId: string;
  name: string;
  score: number;
  distance: number;
  verified: number;
}

export interface Board {
  board: string;
  total: number;
  entries: BoardEntry[];
}

export interface Submitted {
  rank: number;
  total: number;
  best: number;
  improved: boolean;
}

export interface RunClaim {
  score: number;
  distance: number;
  ticks: number;
  bestChain: number;
  rules: number;
  spawn: Spawn;
  replay: string;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

export function startTicket(board: string): Promise<Ticket> {
  return req<Ticket>('POST', '/v1/runs', { board });
}

export async function submitRun(t: Ticket, playerId: string, name: string, claim: RunClaim): Promise<Submitted> {
  const turnstile = SITEKEY ? await turnstileToken() : undefined;
  return req<Submitted>('POST', '/v1/runs/finish', { ...t, playerId, name, ...claim, turnstile });
}

export function fetchBoard(board: string, limit = 10): Promise<Board> {
  return req<Board>('GET', `/v1/boards/${board}?limit=${limit}`);
}

export function fetchRank(board: string, score: number): Promise<{ rank: number; total: number }> {
  return req('GET', `/v1/boards/${board}/rank?score=${Math.floor(score)}`);
}

// ------------------------------------------------------------------ Turnstile (only when a site key is configured)
interface TurnstileApi {
  render(el: HTMLElement, o: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}
let turnstileLoad: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  turnstileLoad ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve((window as unknown as { turnstile: TurnstileApi }).turnstile);
    s.onerror = () => reject(new Error('verification unavailable'));
    document.head.appendChild(s);
  });
  return turnstileLoad;
}

async function turnstileToken(): Promise<string> {
  const ts = await loadTurnstile();
  const box = document.createElement('div');
  box.className = 'g-turnstile';
  document.body.appendChild(box);
  try {
    return await new Promise<string>((resolve, reject) => {
      ts.render(box, {
        sitekey: SITEKEY,
        appearance: 'interaction-only',
        callback: resolve,
        'error-callback': () => reject(new Error('verification failed')),
        'expired-callback': () => reject(new Error('verification expired')),
      });
    });
  } finally {
    box.remove();
  }
}

// ------------------------------------------------------------------ identity (anonymous, kept on this device)
function load(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function save(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
}

export function playerId(): string {
  let id = load('eb.skim.player');
  if (!id || !/^[a-z0-9-]{8,40}$/.test(id)) {
    id = crypto.randomUUID();
    save('eb.skim.player', id);
  }
  return id;
}

export const playerName = {
  get: (): string => load('eb.skim.name') ?? '',
  set: (v: string): void => save('eb.skim.name', v),
};

/** best score this device has submitted to a board */
export const sentBest = {
  get: (board: string): number => Number(load(`eb.skim.sent.${board}`)) || 0,
  set: (board: string, v: number): void => save(`eb.skim.sent.${board}`, String(v)),
};

/** same rules as the server (api/src/validate.ts cleanName), minus the word filter */
export function nameProblem(raw: string): string | null {
  const s = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!s) return 'Enter a name';
  if ([...s].length > 12) return 'Up to 12 characters';
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(s)) return 'Letters, numbers, space, _ . - only';
  return null;
}
