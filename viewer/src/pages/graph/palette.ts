// Colours for graph groups. The first 12 hues sit 30 degrees apart, visited 150 degrees at a
// step so neighbours in the list are far apart and no two of the 12 are close (a golden-angle
// walk brought colours 8 apart back within 20 degrees). Later rounds shift by a fraction of a
// step. Then lightness alternates between two steps chosen so every colour keeps at
// least 3:1 contrast against both the light canvas (#f6f6f3) and the dark one (#111214).

const SLOTS = 12;
/** The palette's first this many colours are all clearly apart; later rounds come back within
 * a few degrees of them, so a colour meant to stand for one thing alone stays among these. */
export const DISTINCT_COLOURS = SLOTS;
const SLOT_DEGREES = 360 / SLOTS;
const STRIDE = 5; // 5 * 30 = 150 degrees; coprime with 12, so the first round visits every slot.
const START_HUE = 255; // Starts near the app's blue accent.
const LIGHTNESS = [0.53, 0.6] as const;
const CHROMA = 0.18;

type Rgb = [number, number, number];

/** OKLab to linear sRGB (Björn Ottosson's matrices). */
function oklabToLinear(l: number, a: number, b: number): Rgb {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

function inGamut(rgb: Rgb): boolean {
  return rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);
}

/** Linear sRGB in gamut for an OKLCH colour, lowering chroma (not lightness) until it fits. */
function oklchToLinear(l: number, c: number, hueDeg: number): Rgb {
  const h = (hueDeg * Math.PI) / 180;
  const at = (chroma: number) => oklabToLinear(l, chroma * Math.cos(h), chroma * Math.sin(h));
  if (inGamut(at(c))) return at(c);
  let lo = 0;
  let hi = c;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(at(mid))) lo = mid;
    else hi = mid;
  }
  return at(lo);
}

function encode(linear: number): number {
  const v = Math.min(1, Math.max(0, linear));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

function hex(rgb: Rgb): string {
  return `#${rgb
    .map((c) =>
      Math.round(encode(c) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** The group colour at a position in the list, as #rrggbb. The same index always gives the same colour. */
export function paletteColour(index: number): string {
  const i = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  const round = Math.floor(i / SLOTS);
  const offset = ((round * 0.382) % 1) * SLOT_DEGREES;
  const hue = (START_HUE + ((i * STRIDE) % SLOTS) * SLOT_DEGREES + offset) % 360;
  return hex(oklchToLinear(LIGHTNESS[i % LIGHTNESS.length] ?? LIGHTNESS[0], CHROMA, hue));
}
