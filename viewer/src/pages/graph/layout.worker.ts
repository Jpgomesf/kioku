// Runs the force layout off the main thread. Receives a LayoutRequest and posts a LayoutReply
// every few iterations (done: false) and once more with the final positions (done: true).
import { forceLayout } from "./forceLayout";
import type { LayoutReply, LayoutRequest } from "./layout";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null;
  postMessage(message: LayoutReply, transfer: Transferable[]): void;
};

function post(id: number, xs: Float64Array, ys: Float64Array, done: boolean): void {
  // Copies, because the layout keeps working on its own arrays after a progress post.
  const reply: LayoutReply = { id, xs: xs.slice(), ys: ys.slice(), done };
  scope.postMessage(reply, [reply.xs.buffer, reply.ys.buffer]);
}

scope.onmessage = (event) => {
  const { id, n, edges, seed } = event.data;
  const result = forceLayout(
    { n, edges, seed },
    { onProgress: (xs, ys) => post(id, xs, ys, false) },
  );
  post(id, result.xs, result.ys, true);
};
