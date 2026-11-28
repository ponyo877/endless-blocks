// Ranking API for Endless Blocks: Skim. Deploy with `npx cf deploy --secrets-file .secrets.env` from this folder.
// The tables live in one SQLite-backed Durable Object (RankingStore), created with the Worker; no D1 database is needed.
// Secrets: RUN_SECRET (random, signs run tokens and hashes clients), ADMIN_TOKEN (for scripts/verify-replay.ts).
// Optional: add a TURNSTILE_SECRET secret (and build the game with VITE_TURNSTILE_SITEKEY) to require Turnstile on every submission.
import { bindings, defineConfig, exports } from 'cf/config';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

const name = 'endless-blocks-api';

export default defineConfig({
  worker: {
    name,
    entrypoint,
    compatibilityDate: '2026-11-01',
    env: {
      STORE: bindings.durableObject({ worker: name, exportName: 'RankingStore' }),
      RUN_SECRET: bindings.secret(),
      ADMIN_TOKEN: bindings.secret(),
      ALLOWED_ORIGINS: bindings.text('https://endless-blocks.ponyo877.com,http://localhost:5173,http://localhost:4173'),
    },
    exports: {
      RankingStore: exports.durableObject({ storage: 'sqlite' }),
    },
    // directly under ponyo877.com: endless-blocks.ponyo877.com is a CNAME to GitHub Pages, whose CAA records would block
    // the certificate of any name below it (api.endless-blocks... could not get one)
    domains: ['endless-blocks-api.ponyo877.com'],
    observability: { enabled: true },
  },
});
