// Local ranking API for playing the game against: npx tsx api/dev/server.mts [port] [db-file]
// Then run the game with VITE_API_URL=http://localhost:8787 npm run dev
import { createServer } from 'node:http';
import worker from '../src/index';
import { localEnv } from './local-store';

const port = Number(process.argv[2]) || 8787;
const env = localEnv({ RUN_SECRET: 'local-dev-secret', ADMIN_TOKEN: 'local-admin' }, process.argv[3] ?? ':memory:');

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  headers.set('cf-connecting-ip', req.socket.remoteAddress ?? '');
  const r = await worker.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`ranking api on http://localhost:${port}`));
