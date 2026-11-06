// Splits a note's body into plain-text blocks. Text is never parsed as HTML.

const BREAK_LINE = /^\s*([-*+] |\d+[.)] |#{1,6} |```)/;
const FENCE = /^\s*```/;

/**
 * Blocks are separated by blank lines. Inside a block, a line that continues prose
 * joins the previous one; list items, headings and fenced code keep their own line.
 */
export function toParagraphs(body: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = () => {
    if (current.length > 0) blocks.push(current);
    current = [];
  };
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (FENCE.test(raw)) {
      if (!inFence) flush();
      current.push(line);
      inFence = !inFence;
      if (!inFence) flush();
      continue;
    }
    if (inFence) {
      current.push(raw.trimEnd());
      continue;
    }
    if (line.length === 0) {
      flush();
      continue;
    }
    const last = current.length - 1;
    if (last >= 0 && !BREAK_LINE.test(raw) && !/^#{1,6} /.test(current[last] ?? "")) {
      current[last] = `${current[last]} ${line}`;
    } else {
      current.push(line);
    }
  }
  flush();
  return blocks;
}

/** "5 Nov" from an ISO date, with the year outside the current one; the input when it does not parse. */
export { formatDay as shortDate } from "../../app/dates";

/** "Related" from "related". */
export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
