'use strict';
/**
 * DSH-GUI 主进程
 * —— 服务管理（内置 Node + dsh）+ 桌面窗口 + 托盘 + 换肤持久化
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');

const DSH_PACKAGE = '@deepseek-ai/dsh'; // 不带版本号：npx 走本地缓存，更新靠"更新 DSH"清缓存重取
const DEFAULT_PORT = 3080;
const LOG_MAX_BYTES = 8 * 1024 * 1024;
const APP_ID = 'com.dshgui.desktop';

// ---------------------------------------------------------------------------
// 基础状态
// ---------------------------------------------------------------------------
let mainWindow = null;
let tray = null;
let service = null; // { proc, mode, port, url, state, startedAt, retriedPort }
let webviewWC = null;
let quitting = false;
let config = {};
let nodeInfo = null; // { dir, bin, version }
let dshVersion = null; // 从 npx 缓存读到的 DSH 版本（用于界面显示）

const APP = {
  isPortable: false,
  exeDir: '',
  dataDir: '',
  logsDir: '',
  dshHome: '',
  runtimeDir: '',
  rootDir: __dirname
};

// ---------------------------------------------------------------------------
// 路径与模式（便携版 / 安装版 / 开发模式）
// ---------------------------------------------------------------------------
/**
 * DSH_HOME 解析：优先复用用户的配置，避免每次重新输入 API Key。
 *   1) 用户显式设置的环境变量 DSH_HOME
 *   2) 用户默认主目录 ~/.dsh（npx / 官方 CLI 使用的位置，含已配置的
 *      settings.yaml / .credentials.yaml / 会话）→ 直接继承，与 npx 行为一致
 *   3) 应用私有目录（全新用户）
 */
function resolveDshHome() {
  const envHome = process.env.DSH_HOME;
  if (envHome && envHome.trim()) return path.resolve(envHome.trim());
  const userHome = path.join(os.homedir(), '.dsh');
  if (fs.existsSync(userHome)) return userHome;
  return path.join(APP.dataDir, 'dsh-home');
}

function resolveAppPaths() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (app.isPackaged && portableDir) {
    APP.isPortable = true;
    APP.exeDir = portableDir;
    APP.dataDir = path.join(portableDir, 'data');
  } else if (app.isPackaged) {
    APP.isPortable = false;
    APP.exeDir = path.dirname(app.getPath('exe'));
    APP.dataDir = path.join(process.env.APPDATA || app.getPath('userData'), 'DSH-GUI');
  } else {
    APP.isPortable = false;
    APP.exeDir = APP.rootDir;
    APP.dataDir = path.join(APP.rootDir, '.dev-data');
  }
  APP.logsDir = path.join(APP.dataDir, 'logs');
  APP.dshHome = resolveDshHome();
  APP.runtimeDir = path.join(APP.dataDir, 'dsh-runtime');
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------
function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > LOG_MAX_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch { /* ignore */ }
}

function createLogStream(name) {
  const file = path.join(APP.logsDir, name);
  rotateIfNeeded(file);
  return fs.createWriteStream(file, { flags: 'a' });
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(APP.logsDir, 'gui.log'), line + '\n');
  } catch { /* ignore */ }
}

function tailFile(file, maxLines = 300) {
  try {
    const size = fs.statSync(file).size;
    const chunk = Math.min(size, 64 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(chunk);
    fs.readSync(fd, buf, 0, chunk, Math.max(0, size - chunk));
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split(/\r?\n/);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 配置（持久化到 dataDir/config.json）
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  port: DEFAULT_PORT,
  servicePort: null, // 实际固定的服务端口（持久化，保证登录态稳定）
  mirror: true,
  autoLaunch: false,
  autoRestart: true,
  // skin: 壁纸/皮肤垫底显示；dshOpacity = DSH 页面背景不透明度（0 = 完全透明透出壁纸，1 = 原样白底）
  skin: { preset: 'midnight', image: null, dshOpacity: 0 }
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(APP.dataDir, 'config.json'), 'utf8'));
    const savedSkin = raw.skin || {};
    let needsSave = false;
    // 迁移旧版换肤配置（旧: 蒙版 opacity / blur / dshOpacity 0.9 → 新: 无模糊，默认全透明）
    if (savedSkin.opacity !== undefined || savedSkin.blur !== undefined) {
      delete savedSkin.opacity;
      delete savedSkin.blur;
      raw.skin = savedSkin;
      needsSave = true;
    }
    if (savedSkin.dshOpacity === 0.9) {
      savedSkin.dshOpacity = 0; // 旧默认 90% → 新默认完全透明
      raw.skin = savedSkin;
      needsSave = true;
    }
    config = { ...DEFAULT_CONFIG, ...raw, skin: { ...DEFAULT_CONFIG.skin, ...savedSkin } };
    if (needsSave) saveConfig();
  } catch {
    config = { ...DEFAULT_CONFIG, skin: { ...DEFAULT_CONFIG.skin } };
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(path.join(APP.dataDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    log('保存配置失败:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Node 运行时解析：优先复用系统 Node（>= MIN_NODE_VERSION 时跳过内置运行时）
// ---------------------------------------------------------------------------
const MIN_NODE_VERSION = '22.19.0';

function nodeRuntimeDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'node-runtime');
  }
  return path.join(APP.rootDir, 'resources', 'node-runtime');
}

function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function versionAtLeast(v, min) {
  const a = parseVersion(v);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

function probeNode(bin) {
  return new Promise((resolve) => {
    const p = spawn(bin, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out.trim()));
    p.on('error', () => resolve(''));
  });
}

/** 探测系统 Node：版本 + 可执行文件路径（一次调用）。 */
function probeSystemNode() {
  return new Promise((resolve) => {
    const p = spawn('node', ['-e', 'process.stdout.write(JSON.stringify({ v: process.version, p: process.execPath }))'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve(null);
      }
    });
    p.on('error', () => resolve(null));
  });
}

async function resolveNode() {
  if (nodeInfo) return nodeInfo;

  // 1) 系统 Node：版本符合要求（>= 22.19.0）→ 直接复用，跳过内置运行时
  if (process.env.DSH_GUI_FORCE_BUNDLED_NODE !== '1') {
    const sys = await probeSystemNode();
    if (sys && sys.v && versionAtLeast(sys.v, MIN_NODE_VERSION)) {
      nodeInfo = { dir: '', bin: 'node', exePath: sys.p, version: sys.v, source: 'system' };
      log(`检测到系统 Node ${sys.v}（>= ${MIN_NODE_VERSION}），跳过内置运行时`);
      return nodeInfo;
    }
    if (sys && sys.v) {
      log(`系统 Node ${sys.v} 低于要求（${MIN_NODE_VERSION}），改用内置运行时`);
    } else {
      log('未检测到系统 Node，使用内置运行时');
    }
  } else {
    log('DSH_GUI_FORCE_BUNDLED_NODE 已设置，强制使用内置运行时');
  }

  // 2) 内置运行时（随应用分发）
  const dir = nodeRuntimeDir();
  const bin = path.join(dir, 'node.exe');
  if (fs.existsSync(bin)) {
    const version = await probeNode(bin);
    if (version) {
      nodeInfo = { dir, bin, exePath: bin, version, source: 'bundled' };
      log(`使用内置 Node: ${bin} (${version})`);
      return nodeInfo;
    }
  }
  throw new Error('找不到可用的 Node.js 运行时（系统 Node 缺失或不满足要求，且内置运行时不可用），请重新安装应用');
}

/** npm/npx 所在目录：使用系统 Node 时跟随系统 npm，否则用内置 npm。 */
function npmBaseDir() {
  if (nodeInfo && nodeInfo.source === 'system' && nodeInfo.exePath) {
    return path.join(path.dirname(nodeInfo.exePath), 'node_modules', 'npm');
  }
  return path.join(nodeRuntimeDir(), 'node_modules', 'npm');
}

function npmCliJs() {
  return path.join(npmBaseDir(), 'bin', 'npm-cli.js');
}

function npxCliJs() {
  return path.join(npmBaseDir(), 'bin', 'npx-cli.js');
}

function nodeEnv(extra = {}) {
  const node = nodeInfo || { dir: '' };
  const env = { ...process.env };
  if (node.dir) env.PATH = `${node.dir}${path.delimiter}${env.PATH || ''}`;
  env.DSH_HOME = APP.dshHome;
  env.NPM_CONFIG_USERCONFIG = path.join(APP.dataDir, 'npmrc');
  env.npm_config_cache = path.join(APP.dataDir, '.npm-cache');
  env.ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/';
  env.DSH_GUI = '1';
  Object.assign(env, extra);
  return env;
}

/** npx 相关操作使用用户自己的 npm 缓存（以便复用用户已安装的 DSH / npx 缓存）。 */
function npxEnv(extra = {}) {
  const env = nodeEnv(extra);
  delete env.npm_config_cache;
  return env;
}

function ensureNpmrc() {
  const npmrc = path.join(APP.dataDir, 'npmrc');
  const content = config.mirror
    ? [
        '# DSH-GUI 生成的 npm 配置（不影响系统全局配置）',
        'registry=https://registry.npmmirror.com',
        'electron_mirror=https://registry.npmmirror.com/-/binary/electron/',
        'electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/'
      ].join('\n') + '\n'
    : '# DSH-GUI 生成的 npm 配置（镜像加速已关闭，使用默认源）\n';
  fs.writeFileSync(npmrc, content, 'utf8');
}

// ---------------------------------------------------------------------------
// npx 缓存工具（DSH 由 npx 负责下载与缓存，这里只读版本 / 清缓存更新）
// ---------------------------------------------------------------------------
function readDshVersion(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

let _npxCacheRoot = null;

/** 用户 npm 缓存根目录（npx 的 _npx 缓存位于其下，与用户自己运行 npx 共享）。 */
async function npxCacheRoot() {
  if (_npxCacheRoot) return _npxCacheRoot;
  const out = (await runNode([npmCliJs(), 'config', 'get', 'cache'], 10000, true)).stdout.trim();
  _npxCacheRoot = out ||
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'npm-cache');
  return _npxCacheRoot;
}

/** 扫描用户 npx 缓存中的 DSH：返回 { bin, version } 或 null。 */
async function scanNpxDsh() {
  const npxRoot = path.join(await npxCacheRoot(), '_npx');
  try {
    for (const entry of fs.readdirSync(npxRoot)) {
      const modulesDir = path.join(npxRoot, entry, 'node_modules');
      const version = readDshVersion(modulesDir);
      if (version) return { bin: path.join(modulesDir, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), version };
    }
  } catch { /* 缓存不存在 = 尚未下载过 */ }
  return null;
}

/** 清除 npx 缓存中的 DSH 条目（只删 dsh，不动其他包）。返回删除的条目数。 */
async function clearNpxDshCache() {
  const npxRoot = path.join(await npxCacheRoot(), '_npx');
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(npxRoot)) {
      const modulesDir = path.join(npxRoot, entry, 'node_modules');
      if (readDshVersion(modulesDir)) {
        fs.rmSync(path.join(npxRoot, entry), { recursive: true, force: true });
        removed++;
      }
    }
  } catch { /* ignore */ }
  return removed;
}

function runNode(args, timeoutMs = 30000, useUserCache = false) {
  return new Promise((resolve) => {
    const node = nodeInfo || { bin: 'node' };
    let p;
    try {
      p = spawn(node.bin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: useUserCache ? npxEnv() : nodeEnv()
      });
    } catch {
      return resolve({ code: -1, stdout: '', stderr: 'spawn failed' });
    }
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      try { p.kill(); } catch { /* ignore */ }
    }, timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: String(e) });
    });
  });
}

// ---------------------------------------------------------------------------
// 服务管理
// ---------------------------------------------------------------------------
function broadcast() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('dsh:state', {
    state: service ? service.state : 'idle',
    url: service ? service.url : null,
    port: service ? service.port : null,
    mode: service ? service.mode : null,
    dshVersion,
    nodeVersion: nodeInfo ? nodeInfo.version : null,
    nodeSource: nodeInfo ? nodeInfo.source : null,
    detail: service ? service.detail : '',
    isPortable: APP.isPortable,
    dataDir: APP.dataDir
  });
}

function setServiceState(state, detail = '') {
  if (!service) service = { state, detail };
  service.state = state;
  service.detail = detail;
  log(`服务状态 -> ${state} ${detail}`);
  updateTray();
  broadcast();
}

function probePort(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (busy) => {
      try { s.destroy(); } catch { /* ignore */ }
      resolve(busy);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1500, () => done(false));
  });
}

function killTree(pid) {
  try {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch { /* ignore */ }
}

function stopService() {
  if (!service || !service.proc) return;
  log('停止 DSH 服务…');
  const proc = service.proc;
  service.proc = null;
  setServiceState('stopped');
  try { proc.kill(); } catch { /* ignore */ }
  killTree(proc.pid);
}

function startService() {
  return _startService();
}

async function _startService(retryWithRandom = false) {
  if (service && (service.state === 'running' || service.state === 'starting' || service.state === 'installing')) {
    log(`服务已在 ${service.state} 状态，忽略重复启动`);
    return;
  }
  setServiceState('starting', '启动中…');

  try {
    const node = await resolveNode();

    // 首次运行判断：npx 缓存中没有 DSH → 启动时 npx 会先下载（可视化进度）
    const cached = await scanNpxDsh();
    dshVersion = cached ? cached.version : null;
    if (!cached) {
      setServiceState('installing', '首次运行：npx 正在获取 DSH…');
    }

    // 端口选择（端口固定对登录态至关重要：DSH 前端用 localStorage 按 origin 存登录态，
    // 端口一变即视为新站点 → 每次都要重新登录）：
    //   1) 已固定的服务端口（config.servicePort，持久化）→ 2) 用户首选端口 → 3) 系统随机
    let port = 0;
    if (!retryWithRandom) {
      const candidates = [config.servicePort, config.port || DEFAULT_PORT].filter((p) => Number.isInteger(p) && p > 0);
      for (const cand of candidates) {
        setServiceState(cached ? 'starting' : 'installing', `检查端口 ${cand} 可用性…`);
        const busy = await probePort(cand);
        if (!busy) {
          port = cand;
          break;
        }
        log(`端口 ${cand} 已被占用，尝试下一个`);
      }
      if (port === 0) log('首选端口均被占用，改用系统空闲端口');
    }

    // npx 下载进度（仅首次运行）：把 npx 的 npm 输出映射到安装覆盖层
    let installPct = 10;
    const reportInstallProgress = (s) => {
      if (!mainWindow || mainWindow.isDestroyed() || !service || service.state !== 'installing') return;
      const line = s.split(/\r?\n/).filter(Boolean).pop() || '';
      if (/added \d+ packages/.test(s)) installPct = Math.max(installPct, 90);
      else installPct = Math.min(80, installPct + 4);
      mainWindow.webContents.send('dsh:state', {
        state: 'installing',
        progress: { stage: 'install', pct: installPct, text: line || '正在下载 DSH…' },
        dshVersion: null,
        nodeVersion: node.version,
        isPortable: APP.isPortable,
        dataDir: APP.dataDir
      });
    };

    const launch = (launchPort) => {
      // 有缓存：直接运行缓存中的 dsh（等价于 npx 解析到的结果，免网络、秒启动、可离线）
      // 无缓存：通过 npx 下载（首次运行 / 更新后），下载完成后落缓存，下次走缓存直跑
      let args;
      let env;
      if (cached && cached.bin) {
        args = [cached.bin, 'web', '--host', '127.0.0.1', '--port', String(launchPort)];
        env = nodeEnv();
      } else {
        args = [npxCliJs(), '-y', DSH_PACKAGE, 'web', '--host', '127.0.0.1', '--port', String(launchPort)];
        env = npxEnv();
      }
      log(`启动 dsh web: ${node.bin} ${args.join(' ')}`);
      const proc = spawn(node.bin, args, {
        cwd: APP.dataDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env
      });
      service.proc = proc;
      service.mode = 'npx';
      service.progress = null;
      service.logStream = createLogStream('dsh-web.log');
      service.retriedPort = false;

      let output = '';
      const handleData = (d) => {
        const s = d.toString('utf8');
        output += s;
        if (output.length > 20000) output = output.slice(-20000);
        if (service.logStream) service.logStream.write(s);
        if (service && service.state === 'installing') reportInstallProgress(s);
        // 上游输出格式可能变化，宽松匹配本机地址 + 端口
        const m = output.match(/https?:\/\/127\.0\.0\.1:(\d+)/);
        if (m && service && service.state !== 'running') {
          service.port = Number(m[1]);
          service.url = `http://127.0.0.1:${service.port}`;
          // 固定并持久化实际端口：保证下次启动 origin 不变，登录状态（localStorage）不丢
          if (config.servicePort !== service.port) {
            config.servicePort = service.port;
            saveConfig();
            log(`已固定服务端口 ${service.port}（持久化保存，确保登录状态稳定）`);
          }
          setServiceState('running', `服务运行于 ${service.url}`);
          // 启动完成后回读缓存中的实际版本号，更新界面显示
          scanNpxDsh().then((found) => {
            if (found && found.version !== dshVersion) {
              dshVersion = found.version;
              log(`DSH 版本: v${dshVersion}（npx 缓存）`);
              broadcast();
            }
          });
        }
      };
      proc.stdout.on('data', handleData);
      proc.stderr.on('data', handleData);

      proc.on('error', (e) => {
        log('服务进程启动失败:', e.message);
        setServiceState('error', `无法启动服务：${e.message}`);
      });

      proc.on('close', (code, signal) => {
        if (service && service.logStream) {
          service.logStream.end();
          service.logStream = null;
        }
        if (!service || service.proc !== proc) return; // 主动停止
        service.proc = null;
        log(`dsh 进程退出 code=${code} signal=${signal}`);
        if (quitting) {
          service = null;
          return;
        }
        // 端口冲突（启动即退出）→ 自动重试随机端口
        if (!service.retriedPort && service.state === 'starting' && code !== 0) {
          service.retriedPort = true;
          log('启动失败（可能是端口冲突），改用系统空闲端口重试');
          stopService();
          _startService(true);
          return;
        }
        setServiceState(code === 0 ? 'stopped' : 'error', code === 0 ? '服务已退出' : `服务异常退出（code ${code}）`);
        // 自动重启（最多 3 次）
        if (config.autoRestart && !quitting) {
          const attempts = service.restartAttempts || 0;
          if (attempts < 3) {
            service.restartAttempts = attempts + 1;
            log(`3 秒后自动重启（第 ${service.restartAttempts} 次）`);
            setTimeout(() => {
              if (!quitting && (!service || service.state === 'stopped' || service.state === 'error')) {
                _startService(true);
              }
            }, 3000);
          }
        }
      });
    };

    launch(port);
  } catch (err) {
    log('启动服务出错:', err);
    setServiceState('error', String(err.message || err));
  }
}

// ---------------------------------------------------------------------------
// API Key 检测（首次使用引导）
// ---------------------------------------------------------------------------
function apiKeyConfigured() {
  // 凭据文件存在即视为已配置（DSH 的 API Key 主要存于 .credentials.yaml）
  if (fs.existsSync(path.join(APP.dshHome, '.credentials.yaml'))) return true;
  for (const file of ['settings.yaml', 'settings.yml', 'settings.json']) {
    try {
      const content = fs.readFileSync(path.join(APP.dshHome, file), 'utf8');
      if (/(apiKey|api_keys|api-key)\s*[:=]\s*["']?[^\s"'{}]/i.test(content)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

/** 解析应用资源路径（打包后位于 process.resourcesPath）。 */
function resPath(name) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, name);
  }
  return path.join(APP.rootDir, 'resources', name);
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------
function updateTray() {
  if (!tray) return;
  const state = service ? service.state : 'idle';
  tray.setToolTip(`DSH-GUI — ${state === 'running' ? `运行中 ${service.url || ''}` : state}`);
}

function createTray() {
  try {
    const iconPath = resPath('tray.png');
    let image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) image = image.resize({ width: 16, height: 16 });
    tray = new Tray(image);
    tray.setToolTip('DSH-GUI');
    const menu = Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { label: '在浏览器中打开', click: () => { if (service && service.url) shell.openExternal(service.url); } },
      { label: '查看日志', click: () => shell.openPath(APP.logsDir) },
      { type: 'separator' },
      { label: '重启服务', click: () => { stopService(); startService(); } },
      { type: 'separator' },
      { label: '完全退出', click: () => { quitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', () => showMainWindow());
  } catch (err) {
    log('创建托盘失败:', err.message);
  }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#0b0e16',
    icon: resPath('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 关闭 → 最小化到托盘（后台服务继续运行）
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('win:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win:maximized', false));

  // webview 挂载
  mainWindow.webContents.on('did-attach-webview', (_e, wc) => {
    webviewWC = wc;
    wc.on('did-fail-load', (_ev, code, desc) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('webview:status', { ok: false, code, desc });
      }
    });
    wc.on('did-finish-load', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('webview:status', { ok: true });
      }
    });
    wc.on('render-process-gone', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('webview:status', { ok: false, code: 'crashed', desc: '页面进程崩溃' });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('app:bootstrap', async () => {
    await resolveNode().catch(() => {});
    if (!dshVersion) {
      const found = await scanNpxDsh().catch(() => null);
      if (found) dshVersion = found.version;
    }
    return {
      version: app.getVersion(),
      isPortable: APP.isPortable,
      dataDir: APP.dataDir,
      logsDir: APP.logsDir,
      dshHome: APP.dshHome,
      nodeVersion: nodeInfo ? nodeInfo.version : null,
      nodeSource: nodeInfo ? nodeInfo.source : null,
      dshVersion,
      config,
      service: service
        ? { state: service.state, url: service.url, port: service.port, mode: service.mode, detail: service.detail, progress: service.progress }
        : { state: 'idle' },
      apiKeyConfigured: apiKeyConfigured()
    };
  });

  ipcMain.handle('service:start', () => startService());
  ipcMain.handle('service:stop', () => stopService());
  ipcMain.handle('service:restart', () => {
    stopService();
    setTimeout(() => startService(), 500);
  });
  ipcMain.handle('service:openBrowser', () => {
    if (service && service.url) shell.openExternal(service.url);
    return service ? service.url : null;
  });
  ipcMain.handle('service:update', async () => {
    // 更新 DSH：清除 npx 缓存中的 DSH → 重启服务时 npx 自动重新下载最新版
    stopService();
    const removed = await clearNpxDshCache();
    dshVersion = null;
    log(`已清除 ${removed} 个 npx DSH 缓存条目，重启服务后将重新下载最新版`);
    setTimeout(() => startService(), 500);
    return { ok: true, removed };
  });

  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:set', (_e, patch) => {
    if (patch && typeof patch === 'object') {
      // 用户修改首选端口 → 重置已固定的服务端口（下次启动按新首选端口重新固定）
      if (patch.port !== undefined) config.servicePort = null;
      config = { ...config, ...patch };
      if (patch.skin) config.skin = { ...config.skin, ...patch.skin };
      saveConfig();
      if (patch.autoLaunch !== undefined) {
        app.setLoginItemSettings({ openAtLogin: !!patch.autoLaunch });
      }
      if (patch.mirror !== undefined) ensureNpmrc();
    }
    return config;
  });

  ipcMain.handle('wallpaper:save', async (_e, buffer, ext) => {
    try {
      const dir = path.join(APP.dataDir, 'themes');
      fs.mkdirSync(dir, { recursive: true });
      const name = `wallpaper-${Date.now()}.${ext || 'png'}`;
      const file = path.join(dir, name);
      await fsp.writeFile(file, Buffer.from(buffer));
      log('已保存背景图:', file);
      return { ok: true, file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('wallpaper:delete', (_e, file) => {
    try {
      const dir = path.join(APP.dataDir, 'themes');
      if (file && file.startsWith(dir)) fs.rmSync(file, { force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('log:tail', () => ({
    gui: tailFile(path.join(APP.logsDir, 'gui.log')),
    web: tailFile(path.join(APP.logsDir, 'dsh-web.log'))
  }));

  ipcMain.handle('path:open', (_e, kind) => {
    const map = { data: APP.dataDir, logs: APP.logsDir, home: APP.dshHome };
    const target = map[kind] || APP.dataDir;
    shell.openPath(target);
  });

  ipcMain.handle('api:keyStatus', () => apiKeyConfigured());

  ipcMain.handle('win:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.handle('win:maximizeToggle', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('win:hide', () => {
    if (mainWindow) mainWindow.hide(); // 最小化到托盘
  });
  ipcMain.handle('win:quit', () => {
    quitting = true;
    app.quit();
  });
  ipcMain.handle('win:isMaximized', () => (mainWindow ? mainWindow.isMaximized() : false));
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.setAppUserModelId(APP_ID);

  app.whenReady().then(async () => {
    resolveAppPaths();
    for (const dir of [APP.dataDir, APP.logsDir, APP.dshHome, path.join(APP.dataDir, 'themes')]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    loadConfig();
    ensureNpmrc();
    // 一次性清理：旧版本地安装目录（现已改为 npx 启动，不再需要）
    if (fs.existsSync(APP.runtimeDir)) {
      try {
        fs.rmSync(APP.runtimeDir, { recursive: true, force: true });
        log(`已清理旧版本地 DSH 安装目录: ${APP.runtimeDir}`);
      } catch (err) {
        log('清理旧版安装目录失败:', err.message);
      }
    }
    log('========================================');
    log(`DSH-GUI v${app.getVersion()} 启动`);
    log(`模式: ${APP.isPortable ? '便携版' : '安装版'}`);
    log(`数据目录: ${APP.dataDir}`);
    if (config.autoLaunch) app.setLoginItemSettings({ openAtLogin: true });

    // 无头模式（DSH_GUI_HEADLESS=1）：不创建窗口/托盘，仅启动服务——用于自动化测试
    if (process.env.DSH_GUI_HEADLESS === '1') {
      log('无头模式：跳过窗口与托盘');
      setTimeout(() => startService(), 500);
      return;
    }

    createWindow();
    createTray();
    registerIpc();

    // 自动启动服务
    setTimeout(() => startService(), 800);
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', () => {
    if (service && service.proc) {
      log('应用退出，终止 DSH 子进程…');
      try { service.proc.kill(); } catch { /* ignore */ }
      killTree(service.proc.pid);
    }
  });

  app.on('window-all-closed', () => {
    // 不退出：常驻托盘
  });
}
