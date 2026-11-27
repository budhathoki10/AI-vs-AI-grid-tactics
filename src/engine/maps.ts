import type { Board, Coord, MapDef, Side, TileKind, UplinkDef } from "./types";

/**
 * Both maps are point-symmetric around the centre tile, so neither start is favoured by geometry.
 * The only asymmetry left is who moves first, which the series runner alternates.
 */
export const MAPS: readonly MapDef[] = [
  {
    id: "foundry",
    name: "Foundry Yard",
    description: "Open centre, scattered pillars. Every uplink is six steps from both starts.",
    width: 9,
    height: 9,
    rows: [
      ".....#...",
      "..#....B.",
      "..U.=.#..",
      ".#....=..",
      "..=.P.=..",
      "..=....#.",
      "..#.=.U..",
      ".A....#..",
      "...#.....",
    ],
  },
  {
    id: "basin",
    name: "Crossfire Basin",
    description: "A fortified centre ringed by barriers, with walled-off flank uplinks.",
    width: 9,
    height: 9,
    rows: [
      "..#.B.#..",
      ".........",
      ".=..#..=.",
      "...=.=...",
      "U#..P..#U",
      "...=.=...",
      ".=..#..=.",
      ".........",
      "..#.A.#..",
    ],
  },
];

export const DEFAULT_MAP_ID = MAPS[0].id;

const UPLINK_NAMES: Record<string, string> = { P: "Prime" };

export function getMap(id: string): MapDef {
  const map = MAPS.find((entry) => entry.id === id);
  if (!map) throw new Error(`Unknown map "${id}"`);
  return map;
}

/**
 * Builds the playable board. With `swapStarts` the two robots trade start tiles,
 * which a series uses to cancel out any positional bias.
 */
export function buildBoard(map: MapDef, swapStarts = false): Board {
  const tiles: TileKind[][] = [];
  const uplinks: UplinkDef[] = [];
  const starts: Partial<Record<Side, Coord>> = {};
  if (map.rows.length !== map.height) throw new Error(`Map ${map.id} has ${map.rows.length} rows, expected ${map.height}`);

  map.rows.forEach((row, y) => {
    if (row.length !== map.width) throw new Error(`Map ${map.id} row ${y} has ${row.length} tiles, expected ${map.width}`);
    tiles.push(
      [...row].map((char, x): TileKind => {
        switch (char) {
          case "#":
            return "wall";
          case "=":
            return "barrier";
          case "U":
          case "P":
            uplinks.push({ id: "", name: UPLINK_NAMES[char] ?? "", at: [x, y], value: char === "P" ? 2 : 1 });
            return "uplink";
          case "A":
          case "B":
            starts[char] = [x, y];
            return "floor";
          case ".":
            return "floor";
          default:
            throw new Error(`Map ${map.id} has unknown tile "${char}" at ${x},${y}`);
        }
      }),
    );
  });

  if (!starts.A || !starts.B) throw new Error(`Map ${map.id} needs both start tiles`);
  // Stable ids and names: prime first, then flanks west to east.
  uplinks.sort((a, b) => b.value - a.value || a.at[0] - b.at[0] || a.at[1] - b.at[1]);
  let flank = 0;
  for (const uplink of uplinks) {
    if (uplink.value > 1) {
      uplink.id = "prime";
      uplink.name = "Prime Uplink";
    } else {
      const label = flank === 0 ? "West" : flank === 1 ? "East" : `Flank ${flank + 1}`;
      uplink.id = label.toLowerCase().replace(/\s+/g, "-");
      uplink.name = `${label} Uplink`;
      flank++;
    }
  }

  return {
    mapId: map.id,
    width: map.width,
    height: map.height,
    tiles,
    uplinks,
    starts: swapStarts ? { A: starts.B, B: starts.A } : { A: starts.A, B: starts.B },
  };
}
