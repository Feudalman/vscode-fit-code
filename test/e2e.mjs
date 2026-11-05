// E2E：分屏自适应 —— 每个编辑器组按自己的宽度独立计算居中；滚动条仍钉在编辑器右边缘
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
console.log('补丁体 + inject.js 已武装，reload…');
await send('Page.reload', { ignoreCache: true });
for (let i = 0; i < 60; i++) { await sleep(500); if (await evaluate(`!!document.querySelector('.monaco-editor')`, 'ready').catch(() => false)) break; }
for (let i = 0; i < 30; i++) { await sleep(500); if (await evaluate(`!!window.__ceLoaded`, 'inj').catch(() => false)) break; }
console.log('ready（inject.js 已加载）');
// 触碰 AUTO_SPLIT 标记：若分屏丢失，开发扩展监视器会在几秒内补分屏（标记被消费后会删掉，故每轮重写）
for (let i = 0; i < 30; i++) {
  writeFileSync('/tmp/ce-work/AUTO_SPLIT', '1');
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
// 量几何：内缩量 = contentLeft − 原生 gutter；居中 ⇔ 左右内缩相等（与面板宽无关，不写死像素）
const M = `(() => {
  const groups = [...document.querySelectorAll('.editor-group-container')];
  const eds = [...(window.__ceEditors||[])].filter(e => { try { const d = e.getDomNode(); return d && d.isConnected && d.closest('.editor-group-container'); } catch { return false; } });
  return groups.map((g, gi) => {
    const ed = eds.find(e => { try { return e.getDomNode().closest('.editor-group-container') === g; } catch { return false; } });
    if (!ed) return { gi, empty: true };
    const li = ed.getLayoutInfo(), dom = ed.getDomNode();
    const gb = g.getBoundingClientRect();
    const sb = dom.querySelector('.scrollbar.vertical');
    const sbr = sb ? sb.getBoundingClientRect() : null;
    const model = ed.getModel();
    return { gi, model: model?.uri.path.split('/').pop(),
      paneW: Math.round(gb.width),
      width: li.width,
      gutter: li.glyphMarginWidth + li.lineNumbersWidth + li.decorationsWidth,
      contentLeft: li.contentLeft, contentWidth: li.contentWidth,
      vsb: li.verticalScrollbarWidth,
      mm: li.minimap.renderMinimap !== 0 ? li.minimap.minimapWidth : 0,
      minimapLeft: li.minimap.minimapLeft,
      // 滚动条右缘到面板右缘的距离：0 = 钉在最右；≈pad = 跟着正文居中
      scrollbarRightGap: sbr ? Math.round(gb.right - sbr.right) : null };
  });
})()`;
const snap = async (t) => console.log(`[${t}] ` + JSON.stringify(await evaluate(M, t), null, 1));
const geom = (e) => ({
  padL: e.contentLeft - e.gutter,
  // 正文区右边界 = width − minimapWidth（Monaco 原生 contentWidth 语义已含 vsb 那几像素）
  padR: (e.width - e.mm) - (e.contentLeft + e.contentWidth),
  centered: Math.abs((e.contentLeft - e.gutter) - ((e.width - e.mm) - (e.contentLeft + e.contentWidth))) <= 1,
});
const fmt = (g) => `左内缩=${g.padL} 右内缩=${g.padR} 面板=${g.paneW}`;

// ============ A. 单窗口三文件 ============
await clickTab('ce-short');
await sleep(2000);
const s = await evaluate(M, 'short');
const sEd = s.find(x => !x.empty);
const sG = geom(sEd);
check('A1 短文件居中：左右内缩相等且 > 0', sG.padL > 0 && sG.centered, fmt({ ...sG, paneW: sEd.paneW }));
check('A1b 短文件居中时滚动条仍钉右边缘', Math.abs(sEd.scrollbarRightGap) <= 1, `距右缘=${sEd.scrollbarRightGap}px`);

await clickTab('ce-mid');
await sleep(2000);
const m = await evaluate(M, 'mid');
const mEd = m.find(x => !x.empty);
const mG = geom(mEd);
check('A2 中文件（放得下）→ 居中且左右对称', mG.padL > 0 && mG.centered, fmt({ ...mG, paneW: mEd.paneW }));
check('A2b 中文件滚动条仍钉右边缘', Math.abs(mEd.scrollbarRightGap) <= 1, `距右缘=${mEd.scrollbarRightGap}px`);

await clickTab('ce-long');
await sleep(2000);
const l = await evaluate(M, 'long');
const lEd = l.find(x => !x.empty);
const lG = geom(lEd);
check('A3 长文件（放不下）→ 撑满，内缩≈0', lG.padL === 0 && Math.abs(lG.padR) <= 1, fmt({ ...lG, paneW: lEd.paneW }));
check('A3b 长文件滚动条仍钉右边缘', Math.abs(lEd.scrollbarRightGap) <= 1, `距右缘=${lEd.scrollbarRightGap}px`);

// ============ B. 分屏（由扩展 AUTO_SPLIT 创建）============
const sp = await evaluate(M, 'split');
snap('B 分屏后');
const left = sp.find(x => !x.empty && x.gi === 0);
const right = sp.find(x => !x.empty && x.gi === 1);
check('B1 分屏两组各有文件', !!left && !!right && left.model !== right.model, `左=${left?.model} 右=${right?.model}`);
if (left && right) {
  const lG2 = geom(left), rG2 = geom(right);
  check('B2 左组（长内容）：撑满（内缩≈0）', Math.abs(lG2.padL) <= 1, `内缩=${lG2.padL}`);
  check('B3 右组（短内容）：居中且左右对称', rG2.padL > 0 && rG2.centered, fmt({ ...rG2, paneW: right.paneW }));
  check('B4 两边独立计算（不再共享同一个居中量）', rG2.padL - lG2.padL > 60, `左=${lG2.padL} 右=${rG2.padL}`);
  check('B5 分屏两组滚动条各自钉在自家右边缘', Math.abs(left.scrollbarRightGap) <= 1 && Math.abs(right.scrollbarRightGap) <= 1, `左=${left.scrollbarRightGap} 右=${right.scrollbarRightGap}`);
  check('B6 分屏两组的 minimap 都在自家右缘（不跟内容左移）',
    Math.abs((left.width - left.vsb) - (left.minimapLeft + left.mm)) <= 1 &&
    Math.abs((right.width - right.vsb) - (right.minimapLeft + right.mm)) <= 1,
    `左mmRight=${left.minimapLeft + left.mm}/${left.width - left.vsb} 右mmRight=${right.minimapLeft + right.mm}/${right.width - right.vsb}`);
}
// 截图
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/fitcode/e2e-split.png', Buffer.from(shot.data, 'base64'));

console.log('\n=== E2E 汇总 ===');
console.log(results.map(r => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`).join('\n'));
const allOk = results.every(r => r.ok);
console.log(allOk ? '\n🎉 端到端全部通过' : '\n存在失败项');
ws.close(); process.exit(allOk ? 0 : 1);
