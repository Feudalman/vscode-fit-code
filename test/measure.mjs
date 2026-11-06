const PORT = +(process.argv[2] || 9338);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = await (
  await fetch(`http://127.0.0.1:${PORT}/json/list`)
).json();
const pages = targets.filter(
  (t) => t.type === "page" && t.url.includes("workbench"),
);
console.log("workbench 窗口数:", pages.length);
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error
      ? p.reject(new Error(JSON.stringify(m.error).slice(0, 120)))
      : p.resolve(m.result);
  }
};
const send = (method, params = {}) => {
  const mid = ++msgId;
  const p = new Promise((resolve, reject) =>
    pending.set(mid, { resolve, reject }),
  );
  ws.send(JSON.stringify({ id: mid, method, params }));
  return Promise.race([
    p,
    sleep(10000).then(() => {
      throw new Error("timeout " + method);
    }),
  ]);
};
const evaluate = async (expression, tag) => {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails)
    return (
      "ERR:" + (r.exceptionDetails.exception?.description || "").slice(0, 150)
    );
  return r.result.value;
};
// 等页面 JS 可响应
await send("Runtime.enable");
let ready = false;
for (let i = 0; i < 40; i++) {
  try {
    await send("Runtime.evaluate", { expression: "1+1", returnByValue: true });
    ready = true;
    break;
  } catch {
    await sleep(2000);
  }
}
if (!ready) {
  console.log("页面始终无响应");
  process.exit(1);
}
console.log("页面 JS 可响应");
// 等 workbench 完全起来
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const r = await evaluate(
    `!!document.querySelector('.monaco-editor') && !!document.querySelector('.statusbar-item')`,
    "w",
  ).catch(() => false);
  if (r) break;
}
await sleep(4000); // 给扩展和注入足够的启动时间
const out = await evaluate(
  `(() => {
  const eds=[...(window.__ftEditors||[])].filter(e=>{try{const d=e.getDomNode();return d&&d.isConnected&&d.closest('.editor-group-container')}catch{return false}});
  const ed=eds[0]; if(!ed) return {state:'no-editor', loaded:!!window.__ftLoaded, editors:window.__ftEditors?window.__ftEditors.size:0};
  const li=ed.getLayoutInfo(), dom=ed.getDomNode();
  const dr=dom.getBoundingClientRect(), gr=dom.closest('.editor-group-container').getBoundingClientRect();
  const vl=dom.querySelector('.view-lines'), vr=vl.getBoundingClientRect();
  const sb=[...document.querySelectorAll('.statusbar-item')];
  const ch=(sb.map(x=>x.textContent).join('|').match(/ce:(\\d+),(\\d+),(\\d+)(?:,(\\d+))?/)||[]);
  const model=ed.getModel();
  let maxLen=0; if(model){const n=Math.min(model.getLineCount(),3000); for(let i=1;i<=n;i++){const L=model.getLineLength(i); if(L>maxLen)maxLen=L;}}
  return { file: model?.uri.path.split('/').pop(), 最长行字符: maxLen,
    信道: ch[0]||'无信道', maxContentWidth: ch[4]?+ch[4]:'未传',
    pad: window.__ftPad ? window.__ftPad.left : null,
    编辑器元素宽: Math.round(dr.width), 面板宽: Math.round(gr.width),
    外缝左: Math.round(dr.left-gr.left),
    contentLeft: li.contentLeft,
    行号区左缘: li.lineNumbersLeft,
    minimap左缘: li.minimap.minimapLeft };
})()`,
  "v",
);
console.log(JSON.stringify(out, null, 1));
ws.close();
process.exit(0);
