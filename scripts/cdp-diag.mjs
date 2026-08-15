#!/usr/bin/env node
/* CDP 诊断 v2：完整异常堆栈 + 全局绑定检查 */
const BASE = 'http://127.0.0.1:9222';

async function main() {
  let list;
  for (let i = 0; i < 20; i++) {
    try {
      list = await fetch(`${BASE}/json`).then((r) => r.json());
      if (list.some((t) => t.type === 'page')) break;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('targets:', list.map((t) => `${t.type} ${t.url.slice(0, 80)}`).join('\n'));
  const page = list.find((t) => t.type === 'page' && !t.url.includes('devtools'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const exceptions = [];

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') {
      const p = msg.params;
      const d = p.exceptionDetails;
      exceptions.push({
        text: d.text,
        url: d.url,
        line: d.lineNumber,
        col: d.columnNumber,
        desc: d.exception?.description || ''
      });
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      exceptions.push({ text: '[log] ' + msg.params.entry.text, url: msg.params.entry.url, line: msg.params.entry.lineNumber });
    }
  };

  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await new Promise((resolve) => (ws.onopen = resolve));
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 5000));

  const evalJs = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return res.result?.result?.value ?? res.result?.result?.description ?? JSON.stringify(res.result);
  };

  console.log('--- 词法绑定检查 ---');
  console.log('typeof dshGui (词法):', await evalJs('typeof dshGui'));
  console.log('typeof window.dshGui:', await evalJs('typeof window.dshGui'));
  console.log('getOwnPropertyDescriptor:', await evalJs('JSON.stringify(Object.getOwnPropertyDescriptor(window,"dshGui"))'));
  console.log('--- 异常（完整） ---');
  console.log(exceptions.length ? JSON.stringify(exceptions, null, 1) : '(无)');
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
