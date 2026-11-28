// Build for `cf deploy` / `cf dev`: the Cloudflare plugin reads cloudflare.config.ts.
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [cloudflare()] });
