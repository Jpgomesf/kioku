// Development-only performance probe for the graph page, run with ?perf=1 on the graph route.
// GraphView imports it only behind import.meta.env.DEV, so production builds leave it out.
// It pans for a fixed number of frames, then animates through levels 0, 3 and back to 0, and
// logs one line with frame-interval and draw-time percentiles.
import { type Camera, pan } from "./camera";
import type { GraphRenderer } from "./renderer";

export interface PerfProbeInput {
  renderer: GraphRenderer;
  nodes: number;
  edges: number;
  layoutMs: number;
  /** The cameras for levels 0 and 3. */
  whole: Camera;
  close: Camera;
  durationMs: number;
}

const PAN_FRAMES = 120;

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round((sorted[i] ?? 0) * 100) / 100;
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/** Pans with setCamera for PAN_FRAMES frames; returns frame intervals and draw times. */
async function panFrames(renderer: GraphRenderer): Promise<{ gaps: number[]; draws: number[] }> {
  const gaps: number[] = [];
  const draws: number[] = [];
  let last = await nextFrame();
  for (let i = 0; i < PAN_FRAMES; i += 1) {
    // Back and forth, so the probe ends near where it started.
    const dx = i < PAN_FRAMES / 2 ? 4 : -4;
    renderer.setCamera(pan(renderer.camera, dx, dx / 2));
    const t = await nextFrame();
    gaps.push(t - last);
    draws.push(renderer.lastDrawMs);
    last = t;
  }
  return { gaps, draws };
}

/** Frame intervals while an animated camera move runs. */
async function animatedFrames(renderer: GraphRenderer, to: Camera, ms: number): Promise<number[]> {
  const gaps: number[] = [];
  let done = false;
  const move = renderer.animateTo(to, ms).then(() => {
    done = true;
  });
  let last = await nextFrame();
  while (!done) {
    const t = await nextFrame();
    gaps.push(t - last);
    last = t;
  }
  await move;
  return gaps;
}

export async function runPerfProbe(input: PerfProbeInput): Promise<void> {
  const { renderer } = input;
  renderer.setCamera(input.whole);
  const { gaps, draws } = await panFrames(renderer);
  const anim = [
    ...(await animatedFrames(renderer, input.close, input.durationMs)),
    ...(await animatedFrames(renderer, input.whole, input.durationMs)),
  ];
  const line = {
    nodes: input.nodes,
    edges: input.edges,
    layoutMs: Math.round(input.layoutMs),
    panP50: percentile(gaps, 50),
    panP95: percentile(gaps, 95),
    drawP95: percentile(draws, 95),
    animP95: percentile(anim, 95),
  };
  console.info(`[graph-perf] ${JSON.stringify(line)}`);
}
