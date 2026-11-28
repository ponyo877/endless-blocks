// Storage for the ranking: the tables live in the SQLite database of one Durable Object.
// Durable Object SQL is synchronous, so handlers read and write without awaiting, which also
// makes each submission atomic (nothing else runs in the object between two awaits).

/** the part of a Durable Object's state the store uses (structural, so Node can stand in for it) */
export interface SqlCursor {
  toArray(): Record<string, unknown>[];
}
export interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlCursor;
}
export interface StoreState {
  storage: {
    sql: SqlStorage;
    transactionSync<T>(f: () => T): T;
  };
}

export interface Db {
  /** first row, or null */
  get<T>(query: string, ...args: unknown[]): T | null;
  all<T>(query: string, ...args: unknown[]): T[];
  run(query: string, ...args: unknown[]): void;
  /** run several writes as one transaction */
  tx(f: () => void): void;
}

const SCHEMA = [
  // best run per player and board
  // verified: 0 not checked yet, 1 re-flown and matched, -1 rejected (hidden from the board)
  `CREATE TABLE IF NOT EXISTS scores (
    board       TEXT    NOT NULL,
    player_id   TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    score       INTEGER NOT NULL,
    distance    INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    best_chain  INTEGER NOT NULL DEFAULT 0,
    rules       INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    verified    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (board, player_id)
  )`,
  'CREATE INDEX IF NOT EXISTS scores_rank ON scores (board, score DESC)',
  // input logs of the best runs, for re-flying them offline (scripts/verify-replay.ts)
  `CREATE TABLE IF NOT EXISTS replays (
    board     TEXT    NOT NULL,
    player_id TEXT    NOT NULL,
    seed      INTEGER NOT NULL,
    spawn     TEXT    NOT NULL,
    ticks     INTEGER NOT NULL,
    score     INTEGER NOT NULL,
    data      TEXT    NOT NULL,
    PRIMARY KEY (board, player_id)
  )`,
  // run tokens are single use
  'CREATE TABLE IF NOT EXISTS used_runs (run_id TEXT PRIMARY KEY, at INTEGER NOT NULL)',
  // submissions per client per minute (key is a salted hash, never the address itself)
  'CREATE TABLE IF NOT EXISTS hits (key TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL)',
];

/** open the store, creating the tables on first use */
export function sqlDb(state: StoreState): Db {
  const { sql } = state.storage;
  for (const s of SCHEMA) sql.exec(s);
  // toArray() runs every statement to completion, writes included
  return {
    get: <T>(q: string, ...a: unknown[]) => (sql.exec(q, ...a).toArray()[0] as T | undefined) ?? null,
    all: <T>(q: string, ...a: unknown[]) => sql.exec(q, ...a).toArray() as T[],
    run: (q: string, ...a: unknown[]) => void sql.exec(q, ...a).toArray(),
    tx: (f: () => void) => state.storage.transactionSync(f),
  };
}
