/// <reference lib="webworker" />
import { PathPlanner } from '../autopilot/planner';

declare const self: DedicatedWorkerGlobalScope;

let planner: PathPlanner | null = null;
let need = 0;
let busy = false;

function pump(): void {
  if (!planner || busy) return;
  busy = true;
  const b = planner.planUntil(need, 25);
  busy = false;
  if (b) self.postMessage({ type: 'samples', ...b }, [b.x.buffer, b.y.buffer, b.z.buffer]);
  if (planner.committed < need) setTimeout(pump, 0);
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'init') {
    planner = new PathPlanner(d.seed);
    need = d.need;
    self.postMessage({ type: 'start', x: planner.startX, z: planner.startZ });
    pump();
  } else if (d.type === 'need') {
    if (d.need > need) {
      need = d.need;
      pump();
    }
  }
};
