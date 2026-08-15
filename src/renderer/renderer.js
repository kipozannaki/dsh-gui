'use strict';
/* DSH-GUI 渲染层逻辑：状态机、视图、换肤、设置、日志、窗口控制 */

const $ = (id) => document.getElementById(id);
const bridge = window.dshBridge;

// 防御：preload 桥接缺失时给出明确提示，避免"静默空壳"
if (!bridge) {
  const root = document.getElementById('app');
  if (root) {
    root.innerHTML =
      '<div style="display:flex;height:100vh;align-items:center;justify-content:center;color:#ff6b6b;font-size:15px;font-family:Segoe UI,Microsoft YaHei,sans-serif;padding:30px;text-align:center;line-height:1.8">' +
      '预加载桥接失败（preload.js 未加载）。<br>请重新安装应用；若问题持续，请查看日志目录中的 gui.log。' +
      '</div>';
  }
  throw new Error('dshBridge is not available');
}

let boot = null;
let currentView = 'home';
let logTab = 'gui';
let logTimer = null;
let apikeyBannerShown = false;
let installDetail = [];
const SKIN_PRESETS = [
  { id: 'midnight', label: '午夜' },
  { id: 'aurora', label: '极光' },
  { id: 'ocean', label: '深海' },
  { id: 'ember', label: '熔岩' },
  { id: 'mesh', label: '抽象网格' },
  { id: 'image', label: '自定义图片' }
];

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
function toast(text, isErr = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

// ---------------------------------------------------------------------------
// 状态渲染
// ---------------------------------------------------------------------------
const STATE_TEXT = {
  idle: '空闲',
  installing: '部署中…',
  starting: '启动中…',
  running: '运行中',
  stopping: '停止中…',
  stopped: '已停止',
  error: '错误'
};

function applyState(s) {
  const state = s.state || 'idle';
  // 顶栏状态
  $('pill-dot').className = 'dot ' + state;
  $('pill-text').textContent = STATE_TEXT[state] || state;
  // 侧栏状态卡
  $('status-dot').className = 'dot ' + state;
  $('status-text').textContent = STATE_TEXT[state] || state;
  $('status-url').textContent = s.url || (state === 'starting' ? '正在分配端口…' : (s.detail || ''));

  // 安装覆盖层
  if (state === 'installing') {
    $('overlay-install').classList.remove('hidden');
    if (s.progress) {
      $('progress-bar').style.width = Math.max(4, Math.min(100, s.progress.pct || 8)) + '%';
      $('progress-text').textContent = s.progress.text || '';
      if (s.progress.text) {
        installDetail.push(s.progress.text);
        if (installDetail.length > 8) installDetail.shift();
        $('progress-detail').textContent = installDetail.join('\n');
        $('progress-detail').scrollTop = $('progress-detail').scrollHeight;
      }
    }
  } else {
    $('overlay-install').classList.add('hidden');
  }

  // 错误覆盖层
  if (state === 'error') {
    $('error-msg').textContent = s.detail || '未知错误';
    $('overlay-error').classList.remove('hidden');
  } else {
    $('overlay-error').classList.add('hidden');
  }

  // 运行中 → 加载 webview
  if (state === 'running' && s.url) {
    const wv = $('dsh-web');
    if (!wv.src || !wv.src.startsWith(s.url)) {
      wv.src = s.url;
    }
    // 首次使用引导
    if (!apikeyBannerShown) {
      checkApiKey();
    }
  }
}

async function checkApiKey() {
  try {
    const ok = await bridge.apiKeyStatus();
    if (!ok) {
      apikeyBannerShown = true;
      $('banner-apikey').classList.remove('hidden');
    } else {
      apikeyBannerShown = true;
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 视图切换
// ---------------------------------------------------------------------------
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

  if (view === 'logs') {
    $('view-logs').classList.remove('hidden');
    $('view-home').classList.add('hidden');
    startLogPolling();
  } else if (view === 'settings') {
    openSettings();
    return; // 设置是抽屉，不切换主视图
  } else {
    $('view-logs').classList.add('hidden');
    $('view-home').classList.remove('hidden');
    stopLogPolling();
  }

  // 会话/工作区 → 在嵌入的 DSH UI 中导航
  if (view === 'sessions' || view === 'workspace') {
    spaNav(view).then((ok) => {
      if (!ok) toast('已切换到应用主界面，请在右侧面板中操作', false);
    });
  }
}

/** 在嵌入的 DSH Web UI 中点击对应导航项（尽力而为） */
async function spaNav(view) {
  const wv = $('dsh-web');
  if (!wv || !wv.src) return false;
  const labels = {
    sessions: ['会话', '对话'],
    workspace: ['工作区'],
    settings: ['设置', '偏好']
  }[view] || [];
  const script = `(() => {
    const labels = ${JSON.stringify(labels)};
    const nodes = Array.from(document.querySelectorAll('a, button, [role="tab"], [role="button"], li'));
    for (const l of labels) {
      for (const el of nodes) {
        const t = (el.textContent || '').trim();
        if (t === l && el.offsetParent !== null) { el.click(); return 'ok:' + l; }
      }
    }
    return 'miss';
  })()`;
  try {
    const r = await wv.executeJavaScript(script, true);
    return String(r).startsWith('ok');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 日志视图
// ---------------------------------------------------------------------------
function startLogPolling() {
  stopLogPolling();
  refreshLogs();
  logTimer = setInterval(refreshLogs, 1500);
}
function stopLogPolling() {
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
}
async function refreshLogs() {
  try {
    const data = await bridge.logTail();
    const lines = logTab === 'gui' ? data.gui : data.web;
    const viewer = $('log-viewer');
    const nearBottom = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 60;
    const text = (lines.length ? lines : ['（暂无日志）']).join('\n');
    if (viewer.textContent !== text) viewer.textContent = text;
    if (nearBottom) viewer.scrollTop = viewer.scrollHeight;
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 换肤：壁纸垫底（窗口背景），DSH 页面文字在其上清晰显示——绝不叠加蒙版
// ---------------------------------------------------------------------------
function applySkin() {
  const skin = boot.config.skin;
  document.body.dataset.skin = skin.preset || 'midnight';
  const img = $('bg-img');
  const hasImage = skin.preset === 'image' && skin.image;
  const blur = Math.max(0, skin.blur || 0);

  if (hasImage) {
    img.src = 'file:///' + skin.image.replace(/\\/g, '/');
    img.classList.add('on');
    img.style.filter = blur > 0 ? `blur(${blur}px)` : 'none';
  } else {
    img.classList.remove('on');
    img.style.filter = 'none';
  }
  renderSkinGrid();
  injectDshSkin();
}

/** 把 DSH 界面的白底改为半透明白色：壁纸从页面下方透出，文字保持清晰。 */
function injectDshSkin() {
  const wv = $('dsh-web');
  if (!wv || !wv.src) return;
  const skin = boot.config.skin;
  // 强度 1 = DSH 原样白底（同样注入白色不透明规则，覆盖此前注入的半透明值）
  const strength = Math.min(1, Math.max(0.6, skin.dshOpacity ?? 0.9));
  const css = [
    'html, body, #root, [class*="_frame"], [class*="_root"] {',
    `  background-color: rgba(255, 255, 255, ${strength}) !important;`,
    '  background-image: none !important;',
    '}'
  ].join('\n');
  try {
    wv.insertCSS(css).catch(() => {});
  } catch { /* ignore */ }
}

function renderSkinGrid() {
  const grid = $('skin-grid');
  grid.innerHTML = '';
  for (const p of SKIN_PRESETS) {
    const card = document.createElement('div');
    card.className = 'skin-card skin-' + p.id + (boot.config.skin.preset === p.id ? ' active' : '');
    const span = document.createElement('span');
    span.textContent = p.label;
    card.appendChild(span);
    card.addEventListener('click', () => {
      const patch = { skin: { ...boot.config.skin, preset: p.id } };
      if (p.id !== 'image') patch.skin.image = null;
      bridge.setConfig(patch).then(() => {
        boot.config.skin = patch.skin;
        applySkin();
        refreshSkinSliders();
      });
    });
    grid.appendChild(card);
  }
}

/** 壁纸模糊滑块仅对自定义图片生效。 */
function refreshSkinSliders() {
  const isImage = boot.config.skin.preset === 'image' && !!boot.config.skin.image;
  $('set-blur').disabled = !isImage;
  $('set-blur').closest('.set-row').querySelector('.hint').textContent = isImage
    ? '仅自定义图片时生效，0 = 完全清晰'
    : '预设皮肤自动清晰展示，此滑块仅自定义图片可用';
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
function openSettings() {
  $('drawer-settings').classList.remove('hidden');
  $('set-port').value = boot.config.port || 3080;
  $('set-mirror').checked = !!boot.config.mirror;
  $('set-autorestart').checked = !!boot.config.autoRestart;
  $('set-autolaunch').checked = !!boot.config.autoLaunch;
  $('set-dshopacity').value = Math.round((boot.config.skin.dshOpacity ?? 0.9) * 100);
  $('set-blur').value = boot.config.skin.blur ?? 0;
  refreshSkinSliders();
  renderAbout();
}
function closeSettings() {
  $('drawer-settings').classList.add('hidden');
}

function renderAbout() {
  $('about-grid').innerHTML = [
    ['应用版本', boot.version],
    ['内置 Node', boot.nodeVersion || '未检测到'],
    ['DSH 版本', boot.dshVersion || '未安装'],
    ['运行模式', boot.isPortable ? '便携版（数据在 exe 同目录 data/）' : '安装版（数据在 %APPDATA%/DSH-GUI/）'],
    ['数据目录', boot.dataDir],
    ['DSH 主目录', boot.dshHome]
  ]
    .map(([k, v]) => `<div><b>${k}</b>：<span>${v || '-'}</span></div>`)
    .join('');
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
async function init() {
  // 窗口控制
  $('wc-min').addEventListener('click', () => bridge.winMinimize());
  $('wc-max').addEventListener('click', async () => {
    const max = await bridge.winMaximizeToggle();
    $('wc-max').textContent = max ? '❐' : '□';
  });
  $('wc-close').addEventListener('click', () => {
    toast('已最小化到系统托盘，后台服务继续运行');
    bridge.winHide();
  });
  bridge.onMaximized((v) => { $('wc-max').textContent = v ? '❐' : '□'; });

  // 导航
  document.querySelectorAll('.nav-item').forEach((b) =>
    b.addEventListener('click', () => switchView(b.dataset.view))
  );
  $('btn-settings').addEventListener('click', () => openSettings());
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('btn-reload').addEventListener('click', () => {
    const wv = $('dsh-web');
    if (wv.src) { wv.reload(); toast('已重新加载'); }
  });
  $('btn-browser').addEventListener('click', () => bridge.openBrowser());
  $('btn-browser2').addEventListener('click', () => bridge.openBrowser());
  $('btn-restart').addEventListener('click', async () => {
    toast('正在重启服务…');
    await bridge.restartService();
  });

  // 状态订阅
  bridge.onState((s) => {
    if (s.dshVersion) boot = { ...boot, dshVersion: s.dshVersion };
    if (s.nodeVersion) boot = { ...boot, nodeVersion: s.nodeVersion };
    applyState(s);
  });
  bridge.onWebviewStatus((s) => {
    if (!s.ok && s.code && s.code !== -3) {
      // -3 = ERR_ABORTED（正常重载），忽略
      toast(`页面加载失败：${s.desc || s.code}`, true);
    }
  });

  // webview 事件
  const wv = $('dsh-web');
  wv.addEventListener('dom-ready', () => {
    if (currentView === 'home') wv.classList.remove('hidden');
    // 页面加载完成后注入皮肤透出（壁纸垫底、文字清晰）
    injectDshSkin();
  });
  wv.addEventListener('did-fail-load', (e) => {
    if (e.code !== -3) toast('DSH 界面加载失败，请检查服务状态', true);
  });

  // 引导横幅
  $('btn-goto-settings').addEventListener('click', () => {
    $('banner-apikey').classList.add('hidden');
    spaNav('settings').then((ok) => { if (!ok) toast('请在右侧面板中打开设置'); });
  });
  $('btn-dismiss-apikey').addEventListener('click', () => $('banner-apikey').classList.add('hidden'));

  // 错误覆盖层
  $('btn-retry').addEventListener('click', async () => {
    $('overlay-error').classList.add('hidden');
    await bridge.restartService();
  });
  $('btn-error-logs').addEventListener('click', () => switchView('logs'));
  $('btn-error-reinstall').addEventListener('click', reinstallDsh);

  // 日志视图
  document.querySelectorAll('.log-tab').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.log-tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      logTab = t.dataset.tab;
      refreshLogs();
    })
  );
  $('btn-log-clear').addEventListener('click', () => { $('log-viewer').textContent = ''; });
  $('btn-log-open').addEventListener('click', () => bridge.openPath('logs'));

  // 设置控件
  $('set-port').addEventListener('change', (e) => {
    const port = parseInt(e.target.value, 10);
    if (port >= 1024 && port <= 65535) {
      bridge.setConfig({ port });
      boot.config.port = port;
      toast('端口已更新，重启服务后生效');
    } else {
      e.target.value = boot.config.port;
      toast('端口需在 1024-65535 之间', true);
    }
  });
  $('set-mirror').addEventListener('change', (e) => {
    bridge.setConfig({ mirror: e.target.checked });
    boot.config.mirror = e.target.checked;
    toast(e.target.checked ? '已启用国内镜像加速' : '已关闭镜像加速');
  });
  $('set-autorestart').addEventListener('change', (e) => {
    bridge.setConfig({ autoRestart: e.target.checked });
    boot.config.autoRestart = e.target.checked;
  });
  $('set-autolaunch').addEventListener('change', (e) => {
    bridge.setConfig({ autoLaunch: e.target.checked });
    boot.config.autoLaunch = e.target.checked;
    toast(e.target.checked ? '已开启开机自启动' : '已关闭开机自启动');
  });
  $('set-dshopacity').addEventListener('input', (e) => {
    const dshOpacity = parseInt(e.target.value, 10) / 100;
    boot.config.skin.dshOpacity = dshOpacity;
    bridge.setConfig({ skin: { dshOpacity } });
    injectDshSkin();
    if (dshOpacity >= 1) toast('DSH 界面已恢复原样白底（100% 不透明）');
  });
  $('set-blur').addEventListener('input', (e) => {
    const blur = parseInt(e.target.value, 10);
    boot.config.skin.blur = blur;
    bridge.setConfig({ skin: { blur } });
    applySkin();
  });
  $('btn-upload').addEventListener('click', () => $('file-wallpaper').click());
  $('file-wallpaper').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
    const buf = await file.arrayBuffer();
    const res = await bridge.saveWallpaper(buf, ext);
    if (res.ok) {
      boot.config.skin = { ...boot.config.skin, preset: 'image', image: res.file };
      await bridge.setConfig({ skin: boot.config.skin });
      applySkin();
      toast('背景图已应用');
    } else {
      toast('背景图保存失败：' + res.error, true);
    }
    e.target.value = '';
  });
  $('btn-remove-wallpaper').addEventListener('click', async () => {
    if (boot.config.skin.image) await bridge.deleteWallpaper(boot.config.skin.image);
    boot.config.skin = { ...boot.config.skin, preset: 'midnight', image: null };
    await bridge.setConfig({ skin: boot.config.skin });
    applySkin();
  });

  $('btn-service-restart').addEventListener('click', async () => {
    closeSettings();
    toast('正在重启服务…');
    await bridge.restartService();
  });
  document.querySelectorAll('.link-btn[data-open]').forEach((b) =>
    b.addEventListener('click', () => bridge.openPath(b.dataset.open))
  );
  $('btn-quit-app').addEventListener('click', () => bridge.winQuit());
  $('btn-reinstall').addEventListener('click', reinstallDsh);

  // 加载引导数据
  boot = await bridge.bootstrap();
  $('foot-meta').textContent = `v${boot.version} · ${boot.isPortable ? '便携版' : '安装版'} · Node ${boot.nodeVersion || '-'} · dsh ${boot.dshVersion || '未安装'}`;
  applySkin();
  refreshSkinSliders();
  applyState(boot.service || { state: 'idle' });

  // 首次进入时若服务尚未运行则自动启动（主进程已自动启动）
  if (!boot.service || (boot.service.state !== 'running' && boot.service.state !== 'starting' && boot.service.state !== 'installing')) {
    if (boot.service && boot.service.state === 'idle') {
      bridge.startService();
    }
  }
}

async function reinstallDsh() {
  const ok = window.confirm('重新安装 DSH 将停止当前服务并重新下载 @deepseek-ai/dsh@0.1.0-rc.6，确定继续吗？');
  if (!ok) return;
  closeSettings();
  installDetail = [];
  $('overlay-install').classList.remove('hidden');
  $('progress-bar').style.width = '4%';
  $('progress-text').textContent = '正在重新安装…';
  $('progress-detail').textContent = '';
  try {
    const res = await bridge.reinstallDsh();
    if (res && !res.ok) {
      $('overlay-install').classList.add('hidden');
      toast('重新安装失败：' + (res.error || '未知错误'), true);
    }
  } catch (err) {
    $('overlay-install').classList.add('hidden');
    toast('重新安装失败：' + err.message, true);
  }
}

document.addEventListener('DOMContentLoaded', init);
