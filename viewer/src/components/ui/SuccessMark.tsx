/**
 * A green check that draws itself once: the ring pops in, then the tick is drawn. It marks a
 * change that went through; the heading beside it says which, so it is hidden from screen
 * readers. Under reduced motion it simply appears.
 */
export function SuccessMark({ size = 64 }: { size?: number }) {
  return (
    <svg
      className="k-success-mark"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
    >
      <circle className="k-success-ring" cx="32" cy="32" r="29" />
      <path className="k-success-tick" d="M20 33l8.5 8.5L45 25" pathLength={1} />
    </svg>
  );
}
