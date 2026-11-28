// Re-fly a recorded run with the world generator and compare the result with what was claimed.
//
//   npx tsx scripts/verify-replay.ts run.json         (a file: {seed, spawn, replay, score, ticks})
//   npx tsx scripts/verify-replay.ts --api <base> --board <board> [--top N] [--admin-token T]
//
// With --api it fetches the top runs of a board, verifies each one and (given an admin token)
// marks them verified (1) or rejected (-1) on the server.
import { readFileSync } from 'node:fs';
import { PathLog } from '../src/autopilot/path';
import { PathPlanner } from '../src/autopilot/planner';
import { GenVoxels } from '../src/game/genVoxels';
import { SPAWN_NEED, spawnFromPath } from '../src/game/spawn';
import { decodeReplay, simulateRun } from '../src/game/replay';
import type { Spawn } from '../src/game/sim';

interface Claim {
  seed: number;
  spawn: Spawn;
  replay: string;
  score: number;
  ticks: number;
}

const spawns = new Map<number, Spawn>();

/** the official start of a world, planned the same way the game does it */
export function expectedSpawn(seed: number): Spawn {
  let sp = spawns.get(seed);
  if (!sp) {
    const planner = new PathPlanner(seed);
    const path = new PathLog();
    while (path.length < SPAWN_NEED) {
      const b = planner.planUntil(SPAWN_NEED, 1000);
      if (b) path.append(b.s0, b.x, b.y, b.z);
    }
    sp = spawnFromPath(path);
    spawns.set(seed, sp);
  }
  return sp;
}

/**
 * Re-fly a run. The planner uses engine Math, so another browser may place the start a hair away;
 * a start more than a few blocks off is a forged spawn.
 */
export async function verify(c: Claim): Promise<{ ok: boolean; score: number; ticks: number; ms: number; chunks: number; spawnOff: number }> {
  const t0 = performance.now();
  const want = expectedSpawn(c.seed);
  const spawnOff = Math.hypot(c.spawn.x - want.x, c.spawn.y - want.y, c.spawn.z - want.z);
  const inputs = await decodeReplay(c.replay);
  const src = new GenVoxels(c.seed);
  const s = simulateRun(c.spawn, inputs, src);
  const score = s.finalScore;
  const ok = score === c.score && inputs.length === c.ticks && !s.alive && spawnOff < 4;
  return { ok, score, ticks: s.tick, ms: performance.now() - t0, chunks: src.chunksGenerated, spawnOff };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const api = opt('--api');
  if (!api) {
    const c = JSON.parse(readFileSync(args[0], 'utf8')) as Claim;
    const r = await verify(c);
    console.log(JSON.stringify({ claimed: c.score, ...r }));
    process.exit(r.ok ? 0 : 1);
  }
  const board = opt('--board')!;
  const top = Number(opt('--top') ?? 20);
  const token = opt('--admin-token') ?? process.env.ADMIN_TOKEN;
  const list = (await (await fetch(`${api}/v1/boards/${board}?limit=${top}`)).json()) as { entries: { playerId: string; name: string; score: number; verified: number }[] };
  for (const e of list.entries) {
    if (e.verified !== 0) continue;
    const res = await fetch(`${api}/v1/replays/${board}/${e.playerId}`);
    if (!res.ok) {
      console.log(`${e.name}: no replay`);
      continue;
    }
    const c = (await res.json()) as Claim;
    const r = await verify(c);
    const off = r.spawnOff > 1e-6 ? ` (start ${r.spawnOff.toFixed(3)} blocks off)` : '';
    console.log(`${e.name} ${e.score}: ${r.ok ? 'OK' : `MISMATCH (re-flown ${r.score})`}${off} in ${r.ms.toFixed(0)} ms`);
    if (token) {
      await fetch(`${api}/v1/admin/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ board, playerId: e.playerId, verified: r.ok ? 1 : -1 }),
      });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
