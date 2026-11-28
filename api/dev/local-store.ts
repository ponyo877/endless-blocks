// Run the ranking Worker in Node: the Durable Object is one in-process RankingStore whose
// SQLite is Node's built-in one. Used by the tests and the local dev server.
import { DatabaseSync } from 'node:sqlite';
import { type Config, type Env, RankingStore } from '../src/index';
import type { StoreState } from '../src/store';

/** a Durable Object's storage, backed by node:sqlite */
export function nodeState(file = ':memory:'): StoreState {
  const db = new DatabaseSync(file);
  return {
    storage: {
      sql: {
        exec(query: string, ...bindings: unknown[]) {
          const st = db.prepare(query);
          const args = bindings as never[];
          if (st.columns().length > 0) {
            const rows = st.all(...args) as Record<string, unknown>[];
            return { toArray: () => rows };
          }
          st.run(...args);
          return { toArray: () => [] };
        },
      },
      transactionSync<T>(f: () => T): T {
        db.exec('BEGIN');
        try {
          const r = f();
          db.exec('COMMIT');
          return r;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
  };
}

/** Worker env whose STORE namespace holds a single local RankingStore */
export function localEnv(config: Config, file = ':memory:'): Env {
  let store: RankingStore | undefined;
  return {
    ...config,
    STORE: {
      idFromName: (name: string) => name,
      get: () => (store ??= new RankingStore(nodeState(file), config)),
    },
  };
}
