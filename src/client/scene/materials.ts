import * as THREE from "three";

/** Deterministic PRNG so the battlefield looks the same on every load. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return [c, c.getContext("2d")!];
}

/**
 * Weathered surface: soft blotches, fine grain and a few hairline scratches, as a grayscale map.
 * Used as both colour detail (multiplied with instance colours) and roughness variation.
 */
export function grainTexture(seed: number, size = 256, strength = 1): THREE.CanvasTexture {
  const [c, ctx] = canvas(size);
  const rand = seeded(seed);
  ctx.fillStyle = "#d8d8d8";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 70; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 8 + rand() * 40;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const shade = rand() > 0.5 ? 255 : 150;
    g.addColorStop(0, `rgba(${shade},${shade},${shade},${0.08 * strength})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 26 * strength;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = `rgba(90,90,90,${0.18 * strength})`;
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 10; i++) {
    ctx.beginPath();
    const x = rand() * size;
    const y = rand() * size;
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rand() - 0.5) * 60, y + (rand() - 0.5) * 60);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(c);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Diagonal safety stripes for barrier bands. */
export function hazardTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128);
  ctx.fillStyle = "#1d1c1a";
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = "#d9a632";
  for (let i = -128; i < 256; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 16, 0);
    ctx.lineTo(i + 16 + 128, 128);
    ctx.lineTo(i + 128, 128);
    ctx.closePath();
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(c);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Soft round sprite for smoke and sparks. */
export function dotTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.6)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export const PALETTE = {
  floorA: "#b8aa92",
  floorB: "#ad9f87",
  plinthTop: "#4d4640",
  plinthBottom: "#2a2826",
  wall: "#a39d93",
  wallCap: "#6c737c",
  barrier: "#c7c0b1",
  pad: "#59616b",
  neutral: "#d6dce4",
  gunmetal: "#5b626c",
  gunmetalDark: "#343a42",
  joint: "#17191d",
};
