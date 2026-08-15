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

const DSH_PACKAGE = '@deepseek-ai/dsh';
const DSH_VERSION = '0.1.0-rc.6'; // 版本锁定：与官方 rc 版本区分，保证稳定性
const DEFAULT_PORT = 3080;
const LOG_MAX_BYTES = 8 * 1024 * 1024;
const APP_ID = 'com.dshgui.desktop';

// ---------------------------------------------------------------------------
// 基础状态
// ---------------------------------------------------------------------------
let mainWindow = null;
let tray = null;
let service = null; // { proc, mode, port, url, state, startedAt, retriedPort }
let installProc = null; // 安装中的 npm 进程（退出时清理）
let webviewWC = null;
let quitting = false;
let config = {};
let nodeInfo = null; // { dir, bin, version }
let dshInfo = null; // { bin, version, source }

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
  APP.dshHome = path.join(APP.dataDir, 'dsh-home');
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
// 内置 Node 运行时
// ---------------------------------------------------------------------------
function nodeRuntimeDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'node-runtime');
  }
  return path.join(APP.rootDir, 'resources', 'node-runtime');
}

async function resolveNode() {
  if (nodeInfo) return nodeInfo;
  const dir = nodeRuntimeDir();
  const bin = path.join(dir, 'node.exe');
  if (fs.existsSync(bin)) {
    const version = await new Promise((resolve) => {
      const p = spawn(bin, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', () => resolve(out.trim()));
      p.on('error', () => resolve(''));
    });
    nodeInfo = { dir, bin, version };
    log(`使用内置 Node: ${bin} (${version})`);
    return nodeInfo;
  }
  // 开发模式下退回系统 node
  const sys = await new Promise((resolve) => {
    const p = spawn('node', ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out.trim()));
    p.on('error', () => resolve(''));
  });
  if (sys) {
    nodeInfo = { dir: '', bin: 'node', version: sys };
    log(`未找到内置 Node，退回系统 node (${sys})`);
    return nodeInfo;
  }
  throw new Error('内置 Node 运行时缺失（resources/node-runtime/node.exe），请重新安装应用');
}

function npmCliJs() {
  return path.join(nodeRuntimeDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

function npxCliJs() {
  return path.join(nodeRuntimeDir(), 'node_modules', 'npm', 'bin', 'npx-cli.js');
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
// DSH 检测与安装
// ---------------------------------------------------------------------------
function readDshVersion(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
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

/**
 * 检测用户环境中已有的 DSH（本地运行时 > 全局安装 > npx 缓存）。
 * 命中即跳过安装流程，直接启动。
 */
async function detectExistingDsh() {
  if (process.env.DSH_GUI_FORCE_INSTALL) {
    log('DSH_GUI_FORCE_INSTALL 已设置，跳过已有安装检测');
    return null;
  }
  // 1) 应用自己的运行时
  const local = path.join(APP.runtimeDir, 'node_modules');
  const v1 = readDshVersion(local);
  if (v1) {
    log(`检测到本地已安装 DSH v${v1}，跳过安装`);
    return { bin: path.join(local, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), version: v1, source: 'local' };
  }
  // 2) 全局安装（npm root -g，以及 Windows 常见全局前缀）
  const g = await runNode([npmCliJs(), 'root', '-g']);
  const candidates = [(g.stdout || '').trim(), path.join(process.env.APPDATA || '', 'npm', 'node_modules')];
  for (const gDir of candidates) {
    if (!gDir) continue;
    const v2 = readDshVersion(gDir);
    if (v2) {
      log(`检测到全局 DSH v${v2}（${gDir}），跳过安装`);
      return { bin: path.join(gDir, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), version: v2, source: 'global' };
    }
  }
  // 3) npx 缓存直接扫描：用户的 npm 缓存下所有 _npx/* 条目（不依赖 npx 版本解析）
  const cacheDir = (await runNode([npmCliJs(), 'config', 'get', 'cache'], 10000, true)).stdout.trim() ||
    path.join(process.env.LOCALAPPDATA || '', 'npm-cache');
  const npxRoot = path.join(cacheDir, '_npx');
  try {
    for (const entry of fs.readdirSync(npxRoot)) {
      const entryDir = path.join(npxRoot, entry, 'node_modules');
      const v3 = readDshVersion(entryDir);
      if (v3) {
        log(`检测到 npx 缓存 DSH v${v3}（${entryDir}），跳过安装`);
        return { bin: path.join(entryDir, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), version: v3, source: 'npx' };
      }
    }
  } catch (err) {
    log('扫描 npx 缓存失败:', err.message);
  }
  // 4) npx --no-install 兜底（某些特殊安装位置）
  const nx = await runNode([npxCliJs(), '--no-install', `${DSH_PACKAGE}@${DSH_VERSION}`, '--version'], 10000, true);
  if (nx.code === 0 && (nx.stdout || '').trim()) {
    const v4 = (nx.stdout || '').trim().split(/\s+/).pop();
    log(`检测到 npx 可执行 DSH ${v4}，跳过安装`);
    return { bin: null, version: v4, source: 'npx' }; // bin 为空时用 npx 启动
  }
  return null;
}

async function verifyInstalled() {
  const dir = path.join(APP.runtimeDir, 'node_modules');
  const version = readDshVersion(dir);
  if (!version) return null;
  const check = await runNode([path.join(dir, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '--version'], 15000);
  if (check.code !== 0) {
    log(`DSH 校验失败: ${(check.stderr || '').slice(0, 300)}`);
    return null;
  }
  return { bin: path.join(dir, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), version, source: 'local' };
}

/** 安装 DSH 到应用数据目录（国内镜像 + 可视化进度）。 */
async function installDsh(onProgress) {
  const node = await resolveNode();
  ensureNpmrc();
  const step = (pct, text, stage = 'install') => onProgress && onProgress({ stage, pct, text });

  step(5, '准备内置 Node 运行时', 'prepare');
  fs.rmSync(APP.runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(APP.runtimeDir, { recursive: true });

  const registry = config.mirror ? 'https://registry.npmmirror.com' : 'https://registry.npmjs.org';
  step(12, `配置 npm 镜像：${registry}`, 'prepare');

  const args = [
    npmCliJs(),
    'install',
    '--prefix',
    APP.runtimeDir,
    `${DSH_PACKAGE}@${DSH_VERSION}`,
    '--no-audit',
    '--no-fund',
    '--no-update-notifier',
    '--loglevel=notice',
    '--progress=false'
  ];

  return await new Promise((resolve) => {
    const p = spawn(node.bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: nodeEnv() });
    installProc = p;
    let out = '';
    const finish = (value) => {
      if (installProc === p) installProc = null;
      resolve(value);
    };
    p.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      out += s;
      const added = s.match(/added (\d+) packages/);
      const reified = s.match(/reify:.*?(\d+)/g);
      const pct = added ? 95 : reified ? Math.min(88, 12 + 70) : 15;
      step(pct, s.split('\n').filter(Boolean).pop() || '正在下载依赖…', 'install');
    });
    p.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      out += s;
      step(15, s.split('\n').filter(Boolean).pop() || '正在安装…', 'install');
    });
    p.on('error', (e) => {
      log('安装进程启动失败:', e.message);
      finish({ ok: false, error: e.message, out });
    });
    p.on('close', async (code) => {
      step(96, '校验安装结果…', 'verify');
      if (code !== 0) {
        log(`npm install 退出码 ${code}`);
        finish({ ok: false, error: `npm install 失败（退出码 ${code}）`, out });
        return;
      }
      const info = await verifyInstalled();
      if (!info) {
        finish({ ok: false, error: '安装完成但校验失败，请检查网络后重试', out });
        return;
      }
      step(100, `DSH v${info.version} 安装完成`, 'done');
      log(`DSH 安装完成: v${info.version}`);
      dshInfo = info;
      finish({ ok: true, info, out });
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
    dshVersion: dshInfo ? dshInfo.version : null,
    nodeVersion: nodeInfo ? nodeInfo.version : null,
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

    // 检测已有安装 → 跳过安装流程
    if (!dshInfo) {
      setServiceState('starting', '检测已有 DSH 安装…');
      const existing = await detectExistingDsh();
      if (existing) {
        dshInfo = existing;
      } else {
        setServiceState('installing', '首次运行：正在部署 DSH 运行时…');
        const result = await installDsh((progress) => {
          if (service) service.progress = progress;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('dsh:state', {
              state: 'installing',
              progress,
              dshVersion: null,
              nodeVersion: node.version,
              isPortable: APP.isPortable,
              dataDir: APP.dataDir
            });
          }
        });
        if (!result.ok) {
          setServiceState('error', result.error);
          return;
        }
      }
    }

    // 端口选择：默认 3080，被占用则交给系统分配（--port 0）
    let port = config.port || DEFAULT_PORT;
    if (retryWithRandom) port = 0;
    else {
      setServiceState('starting', `检查端口 ${port} 可用性…`);
      const busy = await probePort(port);
      if (busy) {
        log(`端口 ${port} 已被占用，改用系统空闲端口`);
        port = 0;
      }
    }

    const launch = (launchPort) => {
      let args;
      let env;
      if (dshInfo.bin) {
        args = [dshInfo.bin, 'web', '--host', '127.0.0.1', '--port', String(launchPort)];
        env = nodeEnv();
      } else {
        // 复用 npx 缓存中的 DSH：通过 npx 启动（使用用户自己的 npm 缓存）
        args = [npxCliJs(), '-y', `${DSH_PACKAGE}@${DSH_VERSION}`, 'web', '--host', '127.0.0.1', '--port', String(launchPort)];
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
      service.mode = dshInfo.source;
      service.progress = null;
      service.logStream = createLogStream('dsh-web.log');
      service.retriedPort = false;

      let output = '';
      const handleData = (d) => {
        const s = d.toString('utf8');
        output += s;
        if (output.length > 20000) output = output.slice(-20000);
        if (service.logStream) service.logStream.write(s);
        const m = s.match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/);
        if (m && service && service.state !== 'running') {
          service.port = Number(m[1]);
          service.url = `http://127.0.0.1:${service.port}`;
          setServiceState('running', `服务运行于 ${service.url}`);
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
    if (!dshInfo) dshInfo = await detectExistingDsh().catch(() => null);
    return {
      version: app.getVersion(),
      isPortable: APP.isPortable,
      dataDir: APP.dataDir,
      logsDir: APP.logsDir,
      dshHome: APP.dshHome,
      nodeVersion: nodeInfo ? nodeInfo.version : null,
      dshVersion: dshInfo ? dshInfo.version : null,
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
  ipcMain.handle('service:install', async () => {
    // 重新安装 DSH
    stopService();
    dshInfo = null;
    const result = await installDsh((progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dsh:state', { state: 'installing', progress });
      }
    });
    if (result.ok) startService();
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  });

  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:set', (_e, patch) => {
    if (patch && typeof patch === 'object') {
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
    if (installProc) {
      log('应用退出，终止安装进程…');
      try { installProc.kill(); } catch { /* ignore */ }
      killTree(installProc.pid);
    }
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
