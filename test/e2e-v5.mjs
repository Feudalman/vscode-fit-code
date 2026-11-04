// E2E v5：分屏自适应 —— 每个编辑器组按自己的宽度独立计算居中
import { readFileSync, writeFileSync } from 'fs';
const PORT = 9337;
const bodyB64 = readFileSync('/tmp/fitcode/patched-body.js').toString('base64');
const injectSrc = readFileSync(new URL('../media/inject.js', import.meta.url).pathname, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('workbench'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map();
const send = (method, params = {}) => {
  const mid = ++msgId; const p = new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
  ws.send(JSON.stringify({ id: mid, method, params }));
  return Promise.race([p, sleep(10000).then(() => { throw new Error('timeout ' + method); })]);
};
ws.onmessage = async (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error).slice(0, 150))) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Fetch.requestPaused') {
    try {
      if (m.params.request.url.includes('workbench.desktop.main.js'))
        await send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }], body: bodyB64 });
      else await send('Fetch.continueRequest', { requestId: m.params.requestId });
    } catch (e) {}
  }
};
const evaluate = async (expression, tag) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 12000);
  if (r.exceptionDetails) throw new Error(`eval[${tag}] ` + (r.exceptionDetails.exception?.description || '').slice(0, 300));
  return r.result.value;
};
const click = async (x, y, button = 'left') => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: injectSrc });
await send('Fetch.enable', { patterns: [{ urlPattern: '*workbench.desktop.main.js*', requestStage: 'Request' }] });
console.log('v5 补丁体 + inject.js 已武装，reload…');
await send('Page.reload', { ignoreCache: true });
for (let i = 0; i < 60; i++) { await sleep(500); if (await evaluate(`!!document.querySelector('.monaco-editor')`, 'ready').catch(() => false)) break; }
for (let i = 0; i < 30; i++) { await sleep(500); if (await evaluate(`(window.__ceChannel||null) !== null`, 'ch').catch(() => false)) break; }
console.log('ready（信道已发布）');
// 触碰 AUTO_SPLIT 标记：若分屏丢失，开发扩展监视器会在几秒内补分屏
writeFileSync('/tmp/ce-work/AUTO_SPLIT', '1');
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  const g = await evaluate(`document.querySelectorAll('.editor-group-container').length`, 'g').catch(() => 0);
  if (g >= 2) { console.log('分屏已就绪'); break; }
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`); };
const clickTab = async (tabName, groupIdx = 0) => {
  const r = await evaluate(`(() => {
    const containers = [...document.querySelectorAll('.tabs-and-actions-container')];
    const c = containers[${groupIdx}]; if (!c) return null;
    const t = [...c.querySelectorAll('.tab')].find(x => (x.textContent || '').includes('${tabName}'));
    if (!t) return null; const b = t.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`, 'tab');
  if (!r) return false;
  await click(r.x, r.y);
  await sleep(1800);
  return true;
};
// 原生 gutter 基准（pad=0 时的 contentLeft）：2 位数行号 66，3 位数 73
const M = `(() => {
  const groups = [...document.querySelectorAll('.editor-group-container')];
  const eds = [...(window.__ceEditors||[])].filter(e => { try { const d = e.getDomNode(); return d && d.isConnected && d.closest('.editor-group-container'); } catch { return false; } });
  return groups.map((g, gi) => {
    const ed = eds.find(e => { try { return e.getDomNode().closest('.editor-group-container') === g; } catch { return false; } });
    if (!ed) return { gi, empty: true };
    const li = ed.getLayoutInfo(), dom = ed.getDomNode();
    const gb = g.getBoundingClientRect();
    const vl = dom.querySelector('.view-lines');
    const vr = vl.getBoundingClientRect();
    const model = ed.getModel();
    return { gi, model: model?.uri.path.split('/').pop(),
      paneW: Math.round(gb.width), groupLeft: Math.round(gb.left),
      textLeft_abs: Math.round(vr.left), textLeftInPane: Math.round(vr.left - gb.left),
      cl_rel: li.contentLeft, minimapLeft: li.minimap.minimapLeft,
      minimapRight: Math.round(li.minimap.minimapLeft + li.minimap.minimapWidth) };
  });
})()`;
const snap = async (t) => console.log(`[${t}] ` + JSON.stringify(await evaluate(M, t), null, 1));

// ============ A. 单窗口三文件 ============
await clickTab('ce-short');
await sleep(2000);
const s = await evaluate(M, 'short');
snap('A1 单窗口 短文件');
const sEd = s.find(x => !x.empty);
check('A1 短文件居中: 内缩≈124（minWidth 640 抬升目标宽）', sEd.textLeftInPane - 66 > 100 && sEd.textLeftInPane - 66 < 160, `内缩=${sEd.textLeftInPane - 66}`);

await clickTab('ce-mid');
await sleep(2000);
const m = await evaluate(M, 'mid');
const mEd = m.find(x => !x.empty);
check('A2 中文件(792px<可用844)小幅居中: 内缩5~60', (mEd.textLeftInPane - 66) > 5 && (mEd.textLeftInPane - 66) <= 60, `内缩=${mEd.textLeftInPane - 66}`);

await clickTab('ce-long');
await sleep(2000);
const l = await evaluate(M, 'long');
const lEd = l.find(x => !x.empty);
check('A3 长文件撑满: 正文左缘≈原生gutter(73±20)', Math.abs(lEd.textLeftInPane - 73) <= 20, `正文左缘=${lEd.textLeftInPane}`);

// ============ B. 分屏（由扩展 AUTO_SPLIT 创建）============
const sp = await evaluate(M, 'split');
snap('B 分屏后');
const left = sp.find(x => !x.empty && x.gi === 0);
const right = sp.find(x => !x.empty && x.gi === 1);
check('B1 分屏两组各有文件', !!left && !!right && left.model !== right.model, `左=${left?.model} 右=${right?.model}`);
if (left && right) {
  const leftPad = left.textLeftInPane - 73;   // 左组长内容：原生 gutter≈73
  const rightPad = right.textLeftInPane - 66; // 右组短内容：原生 gutter≈66
  check('B2 左组长内容：撑满（内缩≤20）', Math.abs(leftPad) <= 20, `内缩=${leftPad}`);
  check('B3 右组短内容：居中（内缩>60）', rightPad > 60, `内缩=${rightPad}`);
  check('B4 两边独立计算（不再共享同一个居中量）', rightPad - leftPad > 60, `左=${leftPad} 右=${rightPad}`);
}

// 截图
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/fitcode/e2e-split.png', Buffer.from(shot.data, 'base64'));

console.log('\n=== E2E v5 汇总 ===');
console.log(results.map(r => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`).join('\n'));
const allOk = results.every(r => r.ok);
console.log(allOk ? '\n🎉 v5 端到端全部通过' : '\n存在失败项');
ws.close(); process.exit(allOk ? 0 : 1);
