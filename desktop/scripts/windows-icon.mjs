import { writeFileSync } from "node:fs";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

const BOW = [
  ".####......####.",
  ".######..######.",
  ".##..##oo##..##.",
  ".##..##oo##..##.",
  ".##..##oo##..##.",
  ".######oo######.",
  ".####..oo..####.",
  "......####......",
  ".....##..##.....",
  "....###..###....",
  "....##....##....",
];
const INK = [0xf4, 0x15, 0x6b];
const GRID = 16;
const BITMAP_SIZES = [16, 24, 32, 48, 64, 128];
const PNG_SIZE = 256;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const cells = BOW.flatMap((row, y) => [...row].flatMap((mark, x) => mark === "." ? [] : [{ x, y, alpha: mark === "o" ? 128 : 255 }]));
const span = (key) => [Math.min(...cells.map((cell) => cell[key])), Math.max(...cells.map((cell) => cell[key]))];
const [minX, maxX] = span("x");
const [minY, maxY] = span("y");
const cols = maxX - minX + 1;
const rows = maxY - minY + 1;

function raster(size) {
  const cell = size / GRID;
  const left = (size - cols * cell) / 2;
  const top = (size - rows * cell) / 2;
  const pixels = Buffer.alloc(size * size * 4);
  for (const { x, y, alpha } of cells) {
    const x0 = left + (x - minX) * cell;
    const y0 = top + (y - minY) * cell;
    for (let py = Math.max(0, Math.floor(y0)); py < Math.min(size, Math.ceil(y0 + cell)); py += 1) {
      for (let px = Math.max(0, Math.floor(x0)); px < Math.min(size, Math.ceil(x0 + cell)); px += 1) {
        const covered = Math.max(0, Math.min(x0 + cell, px + 1) - Math.max(x0, px)) * Math.max(0, Math.min(y0 + cell, py + 1) - Math.max(y0, py));
        const at = (py * size + px) * 4;
        pixels[at] = INK[0];
        pixels[at + 1] = INK[1];
        pixels[at + 2] = INK[2];
        pixels[at + 3] = Math.min(255, pixels[at + 3] + Math.round(covered * alpha));
      }
    }
  }
  return pixels;
}

function bitmap(size) {
  const pixels = raster(size);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const stride = Math.ceil(size / 32) * 4;
  const colors = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const from = ((size - 1 - y) * size + x) * 4;
      const to = (y * size + x) * 4;
      colors[to] = pixels[from + 2];
      colors[to + 1] = pixels[from + 1];
      colors[to + 2] = pixels[from];
      colors[to + 3] = pixels[from + 3];
      if (pixels[from + 3] === 0) mask[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  header.writeUInt32LE(colors.length + mask.length, 20);
  return Buffer.concat([header, colors, mask]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, checksum]);
}

function png(size) {
  const pixels = raster(size);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const row = size * 4;
  const raw = Buffer.alloc(size * (row + 1));
  for (let y = 0; y < size; y += 1) pixels.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row);
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const images = [...BITMAP_SIZES.map((size) => ({ size, data: bitmap(size) })), { size: PNG_SIZE, data: png(PNG_SIZE) }];
const directory = Buffer.alloc(6 + 16 * images.length);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(images.length, 4);
let offset = directory.length;
images.forEach(({ size, data }, index) => {
  const at = 6 + 16 * index;
  directory[at] = size % 256;
  directory[at + 1] = size % 256;
  directory.writeUInt16LE(1, at + 4);
  directory.writeUInt16LE(32, at + 6);
  directory.writeUInt32LE(data.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += data.length;
});
writeFileSync(path.join(import.meta.dirname, "..", "assets", "emma.ico"), Buffer.concat([directory, ...images.map((image) => image.data)]));
