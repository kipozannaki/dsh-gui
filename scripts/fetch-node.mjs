#!/usr/bin/env node
/**
 * fetch-node.mjs — 下载并解包内置 Node.js 运行时（win-x64）到 resources/node-runtime/。
 *
 * - 默认从 npmmirror 下载（国内快），可通过环境变量 NODE_MIRROR 覆盖。
 * - 自动挑选 latest-v22.x 中 >= 22.19.0 的最新版本（满足 dsh 的 Node >= 22 需求）。
 * - 纯 Node 实现 ZIP 解包（仅解出运行时需要的文件），零依赖，可在 CI 中运行。
 */
import { createWriteStream, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "resources", "node-runtime");
const MIRRORS = [
  process.env.NODE_MIRROR || "https://registry.npmmirror.com/-/binary/node",
  "https://npmmirror.com/mirrors/node",
  "https://nodejs.org/dist"
];
const MIN_VERSION = "22.19.0";

async function fetchJson(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`索引不是 JSON（可能是 HTML 错误页）— ${url}`);
  }
}

function cmpVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

async function pickVersion() {
  let lastError;
  for (const mirror of MIRRORS) {
    try {
      const index = await fetchJson(`${mirror}/latest-v22.x/`); // [{ name: "...win-x64.zip", ... }]
      const versions = (Array.isArray(index) ? index : index.files || [])
        .map((f) => (typeof f === "string" ? f : f.name))
        .filter((f) => /^node-v22\.\d+\.\d+-win-x64\.zip$/.test(f))
        .map((f) => f.replace(/^node-v/, "").replace(/-win-x64\.zip$/, ""))
        .sort(cmpVersions)
        .reverse();
      if (versions.length === 0) throw new Error("索引里没有 win-x64 zip");
      const chosen = versions.find((v) => cmpVersions(v, MIN_VERSION) >= 0) ?? versions[0];
      return { version: chosen, mirror };
    } catch (err) {
      lastError = err;
      console.warn(`镜像 ${mirror} 不可用: ${err.message}`);
    }
  }
  throw lastError ?? new Error("所有镜像均不可用");
}

async function download(url, dest) {
  console.log(`下载 ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  const type = res.headers.get("content-type") || "";
  if (type.includes("text/html")) throw new Error(`返回的是 HTML 而非 zip — ${url}`);
  await pipeline(res.body, createWriteStream(dest));
  console.log(`已下载 ${dest}`);
}

/** 极简 ZIP 读取：解析 EOCD + 中央目录，按需 inflate。 */
function readZip(buffer, wanted) {
  // 定位 EOCD（尾部 22 字节起，最长 65557 字节内搜索）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("无效的 zip（找不到 EOCD）");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error("中央目录损坏");
    const method = buffer.readUInt16LE(p + 10);
    const flags = buffer.readUInt16LE(p + 8);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const nameBuf = buffer.subarray(p + 46, p + 46 + nameLen);
    const name = flags & 0x800 ? Buffer.from(nameBuf).toString("utf8") : nameBuf.toString("latin1");
    entries.push({ name, method, compSize, localOffset, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries.map((e) => {
    const local = e.localOffset;
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`local 头损坏: ${e.name}`);
    const nameLen = buffer.readUInt16LE(local + 26);
    const extraLen = buffer.readUInt16LE(local + 28);
    const dataStart = local + 30 + nameLen + extraLen;
    const data = buffer.subarray(dataStart, dataStart + e.compSize);
    return { ...e, data };
  });
}

function extractEntries(zip, wanted) {
  const files = new Map();
  for (const entry of zip) {
    if (entry.name.endsWith("/")) continue;
    const norm = entry.name.replaceAll("\\", "/");
    const match = wanted.find((w) => norm === w || norm.startsWith(w + "/"));
    if (!match) continue;
    let content;
    if (entry.method === 0) content = entry.data;
    else if (entry.method === 8) content = inflateRawSync(entry.data);
    else throw new Error(`不支持的压缩方式 ${entry.method}: ${entry.name}`);
    files.set(norm, content);
  }
  return files;
}

async function main() {
  const { version, mirror } = process.env.NODE_VERSION ? { version: process.env.NODE_VERSION, mirror: MIRRORS[0] } : await pickVersion();
  const prefix = `node-v${version}-win-x64`;
  const zipUrl = `${mirror}/v${version}/${prefix}.zip`;
  const zipPath = path.join(ROOT, ".tmp", `${prefix}.zip`);
  mkdirSync(path.dirname(zipPath), { recursive: true });

  if (!existsSync(zipPath)) await download(zipUrl, zipPath);
  const buf = await (await import("node:fs/promises")).readFile(zipPath);
  const zip = readZip(buf, []);

  // 只解出运行时需要的文件
  const wanted = [
    `${prefix}/node.exe`,
    `${prefix}/npm.cmd`,
    `${prefix}/npx.cmd`,
    `${prefix}/node_modules/npm`
  ];
  const files = extractEntries(zip, wanted);
  if (!files.has(`${prefix}/node.exe`)) throw new Error("zip 中没有 node.exe");

  mkdirSync(OUT_DIR, { recursive: true });
  const strip = (name) => name.slice(prefix.length + 1);
  for (const [name, content] of files) {
    const rel = strip(name);
    const dest = path.join(OUT_DIR, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  writeFileSync(path.join(OUT_DIR, "VERSION"), version + "\n");
  console.log(`内置 Node 运行时已就绪: ${OUT_DIR} (v${version})`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
