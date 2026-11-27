/** Team colours: saturated enough to read on the warm battlefield, distinct from each other and from the neutral uplinks. */
export const TEAM_COLORS = [
  { id: "cobalt", name: "Cobalt", hex: "#4c7dff" },
  { id: "vermilion", name: "Vermilion", hex: "#ff5b3a" },
  { id: "jade", name: "Jade", hex: "#1fbf8a" },
  { id: "amber", name: "Amber", hex: "#f2b233" },
  { id: "violet", name: "Violet", hex: "#9a6bff" },
  { id: "cyan", name: "Cyan", hex: "#25c2e0" },
  { id: "magenta", name: "Magenta", hex: "#ec4c9b" },
  { id: "bone", name: "Bone", hex: "#e4dfd1" },
] as const;

export function colorName(hex: string): string {
  return TEAM_COLORS.find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.name ?? hex;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Rough perceptual distance (redmean). Used to stop two teams picking near-identical colours. */
export function colorDistance(a: string, b: string): number {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const rm = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

export const MIN_COLOR_DISTANCE = 120;
