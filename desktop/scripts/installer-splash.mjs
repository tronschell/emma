import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const width = 420;
const height = 260;
const paper = 0x1c1b1e;
const washInk = 0xcb4e8b;
const plinthInk = 0xcf9bb3;
const eyebrowInk = 0xe481ad;
const headlineInk = 0xf3eef0;
const mutedInk = 0xaaa1a8;
const markInk = 0xf4156b;
const frameDelay = 40;

const bayer = [
  [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
];
const threshold = (x, y) => (bayer[y % 8][x % 8] + 0.5) / 64;

const mix = (base, ink, alpha) => {
  const channel = (shift) => Math.round(((base >> shift) & 255) + ((((ink >> shift) & 255) - ((base >> shift) & 255)) * alpha));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
};

const glyphs = {
  " ": ".....,.....,.....,.....,.....,.....,.....",
  ".": ".....,.....,.....,.....,.....,.##..,.##..",
  A: ".###.,#...#,#...#,#####,#...#,#...#,#...#",
  B: "####.,#...#,#...#,####.,#...#,#...#,####.",
  C: ".###.,#...#,#....,#....,#....,#...#,.###.",
  D: "####.,#...#,#...#,#...#,#...#,#...#,####.",
  E: "#####,#....,#....,####.,#....,#....,#####",
  F: "#####,#....,#....,####.,#....,#....,#....",
  G: ".###.,#...#,#....,#.###,#...#,#...#,.###.",
  H: "#...#,#...#,#...#,#####,#...#,#...#,#...#",
  I: "#####,..#..,..#..,..#..,..#..,..#..,#####",
  J: "..###,...#.,...#.,...#.,...#.,#..#.,.##..",
  K: "#...#,#..#.,#.#..,##...,#.#..,#..#.,#...#",
  L: "#....,#....,#....,#....,#....,#....,#####",
  M: "#...#,##.##,#.#.#,#.#.#,#...#,#...#,#...#",
  N: "#...#,##..#,#.#.#,#..##,#...#,#...#,#...#",
  O: ".###.,#...#,#...#,#...#,#...#,#...#,.###.",
  P: "####.,#...#,#...#,####.,#....,#....,#....",
  Q: ".###.,#...#,#...#,#...#,#.#.#,#..#.,.##.#",
  R: "####.,#...#,#...#,####.,#.#..,#..#.,#...#",
  S: ".####,#....,#....,.###.,....#,....#,####.",
  T: "#####,..#..,..#..,..#..,..#..,..#..,..#..",
  U: "#...#,#...#,#...#,#...#,#...#,#...#,.###.",
  V: "#...#,#...#,#...#,#...#,#...#,.#.#.,..#..",
  W: "#...#,#...#,#...#,#.#.#,#.#.#,##.##,#...#",
  X: "#...#,#...#,.#.#.,..#..,.#.#.,#...#,#...#",
  Y: "#...#,#...#,.#.#.,..#..,..#..,..#..,..#..",
  Z: "#####,....#,...#.,..#..,.#...,#....,#####",
};

const textWidth = (text, scale, tracking) => text.length * 5 * scale + (text.length - 1) * (scale + tracking);

const bowRects = [...readFileSync(path.join(desktop, "assets/emma.icon/Assets/bow.svg"), "utf8")
  .matchAll(/<rect x="(\d+)" y="(\d+)"[^>]*?(?:opacity="([\d.]+)")?\s*\/>/g)]
  .map(([, x, y, opacity]) => ({ x: Number(x), y: Number(y), faint: opacity !== undefined }));
const bowUnit = 40;
const bowLeft = Math.min(...bowRects.map((rect) => rect.x));
const bowTop = Math.min(...bowRects.map((rect) => rect.y));
const bowColumns = (Math.max(...bowRects.map((rect) => rect.x)) - bowLeft) / bowUnit + 1;

const surface = () => {
  const pixels = new Uint32Array(width * height).fill(paper);
  const at = (x, y) => pixels[y * width + x];
  const put = (x, y, rgb) => { if (x >= 0 && x < width && y >= 0 && y < height) pixels[y * width + x] = rgb; };
  const block = (x, y, size, rgb) => { for (let dy = 0; dy < size; dy += 1) for (let dx = 0; dx < size; dx += 1) put(x + dx, y + dy, rgb); };
  return { pixels, at, put, block };
};

const drawWash = (canvas) => {
  const cell = 2;
  for (let y = 0; y * cell < height; y += 1) for (let x = 0; x * cell < width; x += 1) {
    const fade = Math.max(0, 1 - (x * cell) / width * 0.95 - (y * cell) / height * 1.15);
    if (fade * 0.8 > threshold(x, y)) canvas.block(x * cell, y * cell, cell, mix(paper, washInk, 0.24));
  }
};

const drawPlinth = (canvas, left, top, boxWidth, boxHeight) => {
  for (let y = 0; y < boxHeight; y += 1) for (let x = 0; x < boxWidth; x += 1) {
    const edge = Math.min(Math.min(x, boxWidth - 1 - x), Math.min(y, boxHeight - 1 - y));
    if (Math.min(edge / 6, 1) * 0.8 > threshold(x, y)) canvas.put(left + x, top + y, mix(canvas.at(left + x, top + y), plinthInk, 0.75));
  }
};

const drawBow = (canvas, left, top, cell) => {
  for (const rect of bowRects) {
    const x = left + ((rect.x - bowLeft) / bowUnit) * cell;
    const y = top + ((rect.y - bowTop) / bowUnit) * cell;
    for (let dy = 0; dy < cell; dy += 1) for (let dx = 0; dx < cell; dx += 1) {
      canvas.put(x + dx, y + dy, rect.faint ? mix(canvas.at(x + dx, y + dy), markInk, 0.5) : markInk);
    }
  }
};

const drawText = (canvas, text, top, scale, tracking, rgb) => {
  let left = Math.round((width - textWidth(text, scale, tracking)) / 2);
  for (const character of text) {
    const rows = glyphs[character].split(",");
    rows.forEach((row, y) => [...row].forEach((ink, x) => { if (ink === "#") canvas.block(left + x * scale, top + y * scale, scale, rgb); }));
    left += 5 * scale + scale + tracking;
  }
};

const trackWidth = 224;
const trackHeight = 20;
const trackLeft = Math.round((width - trackWidth) / 2);
const trackTop = 182;
const chipWidth = 56;
const steps = 4;

const background = surface();
drawWash(background);
drawText(background, "WELCOME TO EMMA", 24, 2, 3, eyebrowInk);
drawBow(background, Math.round((width - bowColumns * 5) / 2), 54, 5);
drawText(background, "INSTALLING...", 124, 4, 1, headlineInk);
drawPlinth(background, trackLeft, trackTop, trackWidth, trackHeight);
drawText(background, "NO ADMIN NEEDED", 226, 2, 3, mutedInk);

const frames = [];
for (let step = 0; step < steps; step += 1) {
  const pixels = background.pixels.slice();
  const left = trackLeft + Math.round((step * (trackWidth - chipWidth)) / (steps - 1));
  for (let y = 0; y < trackHeight; y += 1) for (let x = 0; x < chipWidth; x += 1) pixels[(trackTop + y) * width + left + x] = eyebrowInk;
  frames.push(pixels);
}

const palette = [];
const indexed = frames.map((pixels) => Uint8Array.from(pixels, (rgb) => {
  const found = palette.indexOf(rgb);
  if (found >= 0) return found;
  palette.push(rgb);
  return palette.length - 1;
}));
const bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
if (palette.length > 256) throw new Error(`The splash needs ${palette.length} colours; a GIF holds 256.`);

const lzw = (indices, minimum) => {
  const clear = 1 << minimum;
  const end = clear + 1;
  const bytes = [];
  let carry = 0;
  let held = 0;
  let size = minimum + 1;
  const emit = (code) => {
    carry |= code << held;
    held += size;
    while (held >= 8) { bytes.push(carry & 255); carry >>= 8; held -= 8; }
  };
  let table = new Map();
  let next = end + 1;
  emit(clear);
  let prefix = indices[0];
  for (let at = 1; at < indices.length; at += 1) {
    const key = (prefix << 8) | indices[at];
    const found = table.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      table = new Map();
      next = end + 1;
      size = minimum + 1;
    } else {
      if (next >= 1 << size) size += 1;
      table.set(key, next);
      next += 1;
    }
    prefix = indices[at];
  }
  emit(prefix);
  emit(end);
  if (held > 0) bytes.push(carry & 255);
  return Buffer.from(bytes);
};

const blocks = (data) => {
  const parts = [];
  for (let at = 0; at < data.length; at += 255) {
    const chunk = data.subarray(at, at + 255);
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
};

const short = (value) => Buffer.from([value & 255, (value >> 8) & 255]);
const table = Buffer.alloc(3 * (1 << bits));
palette.forEach((rgb, at) => { table[at * 3] = (rgb >> 16) & 255; table[at * 3 + 1] = (rgb >> 8) & 255; table[at * 3 + 2] = rgb & 255; });

const gif = [
  Buffer.from("GIF89a", "latin1"),
  short(width), short(height), Buffer.from([0x80 | 0x70 | (bits - 1), 0, 0]),
  table,
  Buffer.from([0x21, 0xff, 0x0b]), Buffer.from("NETSCAPE2.0", "latin1"), Buffer.from([3, 1, 0, 0, 0]),
];
for (const indices of indexed) {
  gif.push(Buffer.from([0x21, 0xf9, 4, 0x04]), short(frameDelay), Buffer.from([0, 0]));
  gif.push(Buffer.from([0x2c]), short(0), short(0), short(width), short(height), Buffer.from([0]));
  gif.push(Buffer.from([bits]), blocks(lzw(indices, bits)));
}
gif.push(Buffer.from([0x3b]));

const output = path.join(desktop, "assets/installer/emma-setup.gif");
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, Buffer.concat(gif));
console.log(`Wrote ${output}: ${width}x${height}, ${frames.length} frames, ${palette.length} colours`);
