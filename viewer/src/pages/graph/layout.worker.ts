// Runs the live simulation off the main thread. It ticks in short slices so "forces" and
// "stop" messages get through between them, posts positions at most every 32 ms, and once
// more when the simulation rests. A "forces" message reheats the same simulation.
import type { WorkerReply, WorkerRequest } from "./layout";
import { Simulation } from "./simulation";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply, transfer: Transferable[]): void;
};

const POST_EVERY_MS = 32;
/** How long one slice ticks before yielding to the message queue. */
const SLICE_MS = 12;

let current: { id: number; rev: number; sim: Simulation } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastPost = 0;

function post(id: number, rev: number, sim: Simulation): void {
  // Copies, because the simulation keeps moving its own arrays.
  const reply: WorkerReply = {
    id,
    rev,
    xs: sim.xs.slice(),
    ys: sim.ys.slice(),
    settled: sim.settled,
  };
  scope.postMessage(reply, [reply.xs.buffer, reply.ys.buffer]);
  lastPost = performance.now();
}

function run(): void {
  timer = null;
  if (!current) return;
  const { id, rev, sim } = current;
  const end = performance.now() + SLICE_MS;
  while (!sim.settled && performance.now() < end) sim.tick();
  if (sim.settled) {
    post(id, rev, sim);
    return;
  }
  if (performance.now() - lastPost >= POST_EVERY_MS) post(id, rev, sim);
  schedule();
}

function schedule(): void {
  if (timer === null) timer = setTimeout(run, 0);
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "start") {
    const { id, n, edges, seed, forces, initial } = message;
    current = { id, rev: 0, sim: new Simulation({ n, edges, seed, initial }, forces) };
    lastPost = 0;
    schedule();
  } else if (message.type === "forces") {
    if (current?.id !== message.id) return;
    current.rev = message.rev;
    current.sim.setForces(message.forces);
    schedule();
  } else if (message.type === "stop") {
    if (current?.id === message.id) current = null;
  }
};
