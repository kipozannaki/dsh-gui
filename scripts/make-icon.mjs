#!/usr/bin/env node
/**
 * make-icon.mjs — 零依赖生成应用图标：
 *   resources/icon.png   (512x512, 窗口/About)
 *   resources/icon.ico   (16/24/32/48/64/128/256, NSIS 安装包 + exe)
 *   resources/tray.png   (32x32 透明托盘图标)
 *
 * 设计：深色圆角渐变底 + 点阵网格 + 青→靛双箭头（呼应 dsh CLI 的 » 提示符）。
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RES = path.join(ROOT, "resources");

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---------- 矢量绘制 ----------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

/** 点到折线的距离（用于描边箭头） */
function distToPolyline(px, py, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = clamp(t, 0, 1);
    const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
    if (d < best) best = d;
  }
  return best;
}

const CHEVRON_OUTER = [
  [0.30, 0.30],
  [0.585, 0.50],
  [0.30, 0.70]
];
const CHEVRON_INNER = [
  [0.475, 0.30],
  [0.76, 0.50],
  [0.475, 0.70]
];

function renderIcon(size, { transparentBg = false } = {}) {
  const px = new Float32Array(size * size * 4);
  const S = 4; // 超采样
  const n = size * S;
  const half = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size; // 0..1
          const v = (y + (sy + 0.5) / S) / size;
          const pxPos = (x + (sx + 0.5) / S - half) / half; // -1..1
          const pyPos = (y + (sy + 0.5) / S - half) / half;

          let cr = 0,
            cg = 0,
            cb = 0,
            ca = 0;

          if (!transparentBg) {
            // 圆角矩形底（radius ~ 22%）
            const rr = 0.22;
            const qx = clamp(Math.abs(pxPos), 0, 1 - rr);
            const qy = clamp(Math.abs(pyPos), 0, 1 - rr);
            const d = Math.hypot(Math.abs(pxPos) - qx, Math.abs(pyPos) - qy);
            const inside = d <= rr;
            if (inside) {
              const t = clamp((v - 0.12) / 0.85, 0, 1);
              cr = lerp(0x10, 0x1b, t);
              cg = lerp(0x16, 0x10, t);
              cb = lerp(0x2e, 0x3a, t);
              ca = 1;
            }
            // 点阵网格
            if (inside) {
              const step = 1 / 9;
              const gx = Math.abs(((u / step) % 1) - 0.5);
              const gy = Math.abs(((v / step) % 1) - 0.5);
              const dr = Math.hypot(gx, gy);
              if (dr < 0.045) {
                const k = (1 - dr / 0.045) * 0.35;
                cr += 90 * k;
                cg += 130 * k;
                cb += 200 * k;
              }
            }
            // 圆角边框
            if (inside && d > rr - 0.018) {
              cr = lerp(cr, 0x9f, 0.5);
              cg = lerp(cg, 0xc8, 0.5);
              cb = lerp(cb, 0xff, 0.5);
            }
          }

          // 箭头发光层
          const glowT = 0.075;
          for (const pts of [CHEVRON_OUTER, CHEVRON_INNER]) {
            const d = distToPolyline(pxPos, pyPos, pts);
            const alpha = clamp(1 - d / glowT, 0, 1);
            if (alpha > 0) {
              cr += lerp(0x22, 0x81, u) * alpha * 0.28;
              cg += lerp(0xd3, 0x8c, u) * alpha * 0.28;
              cb += lerp(0xee, 0xf8, u) * alpha * 0.28;
              ca += alpha * 0.28;
            }
          }
          // 箭头本体
          const stroke = 0.058;
          const edge = 0.004;
          for (const pts of [CHEVRON_OUTER, CHEVRON_INNER]) {
            const d = distToPolyline(pxPos, pyPos, pts);
            const alpha = clamp((stroke - d) / edge, 0, 1);
            if (alpha > 0) {
              const t = clamp((u - 0.26) / 0.5, 0, 1);
              cr += lerp(0x67, 0x5c, t) * alpha;
              cg += lerp(0xe8, 0xc2, t) * alpha;
              cb += lerp(0xf9, 0xfa, t) * alpha;
              ca += alpha;
            }
          }

          r += clamp(cr, 0, 255);
          g += clamp(cg, 0, 255);
          b += clamp(cb, 0, 255);
          a += clamp(ca, 0, 1);
        }
      }
      const inv = 1 / (S * S);
      const i = (y * size + x) * 4;
      px[i] = r * inv;
      px[i + 1] = g * inv;
      px[i + 2] = b * inv;
      px[i + 3] = Math.min(255, a * inv * 255);
    }
  }
  return Buffer.from(px);
}

function encodeIco(sizes, make) {
  const images = sizes.map((s) => make(s));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dirs = [];
  const blobs = [];
  let offset = 6 + images.length * 16;
  images.forEach((png, i) => {
    const s = sizes[i];
    const dir = Buffer.alloc(16);
    dir[0] = s >= 256 ? 0 : s;
    dir[1] = s >= 256 ? 0 : s;
    dir[2] = 0;
    dir[3] = 0;
    dir.writeUInt16LE(1, 4); // color planes
    dir.writeUInt16LE(32, 6); // bpp
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(offset, 12);
    offset += png.length;
    dirs.push(dir);
    blobs.push(png);
  });
  return Buffer.concat([header, ...dirs, ...blobs]);
}

mkdirSync(RES, { recursive: true });

const iconPng512 = encodePng(512, 512, renderIcon(512));
writeFileSync(path.join(RES, "icon.png"), iconPng512);
console.log("resources/icon.png (512x512)");

const ico = encodeIco([16, 24, 32, 48, 64, 128, 256], (s) => encodePng(s, s, renderIcon(s)));
writeFileSync(path.join(RES, "icon.ico"), ico);
console.log("resources/icon.ico (16..256)");

const tray = encodePng(32, 32, renderIcon(32, { transparentBg: true }));
writeFileSync(path.join(RES, "tray.png"), tray);
console.log("resources/tray.png (32x32)");
