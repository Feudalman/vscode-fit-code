/* ---------------------------------------------------------------
   FitCode —— 渲染层（每编辑器独立自适应居中·rulers 载体）

   协议：bundle 补丁的 computeLayout 从【本编辑器自己的 rulers 选项】
   （EditorOption 117，inject 通过 updateOptions({rulers:[{column:pad,
   color:'transparent'}]}) 写入）读取内缩量，应用到
   glyphMargin/行号/装饰/contentLeft（+pad）、contentWidth（-2*pad）。
   rulers 是每编辑器独立的真实 option → 分屏互不干扰；
   改 rulers 本身就会触发布局重算（无需额外触发器）；透明色不可见。

   minimap 与滚动条【不跟着内容走】：minimap 保持原生位置；
   滚动条由 bundle 第四处补丁（EditorScrollbar._setLayout 把承载正文的
   容器加宽 pad）钉在编辑器右边缘。

   本脚本职责：对每个主编辑器，读自己的 model 算最长行视觉列数，
   按自己的面板宽算出 pad，写入 rulers。

   两条与“闪”相关的设计：
   1) 事件驱动：切文件/改内容/改布局时立刻重算，切 tab 时能赶在第一帧前写好，
      不再依赖定时轮询（轮询只留作兜底）。
   2) 结果缓存：按 model 对象缓存（同一次会话），并按文件 uri 持久化到
      localStorage（跨会话）—— 命中时直接复用，不再扫全文。

   纯自适应：内容放得下就居中，放不下自动撑满 + 横向滚动。无阈值。
   --------------------------------------------------------------- */
(function () {
  "use strict";
  if (window.__ftLoaded) return;
  window.__ftLoaded = true;

  // ---------- 配置 ----------
  // 渲染层拿不到 VSCode 的设置 API，所以走一条文件通道：扩展把 fitcode.* 写到
  // bundle 旁边的 fitcode.config.json，这里定时（以及窗口聚焦时）拉取，准实时生效。
  var CFG_REL = "../../../workbench/fitcode.config.json"; // 相对 workbench.html
  var CFG_POLL_MS = 2000;
  var DEFAULTS = {
    center: true, // 是否居中（false = 回归原生布局）
    minTextWidth: 640, // 最小正文宽
    paddingRight: 20, // 正文右侧额外留白
    animate: true, // 宽度变化是否渐变（纯 CSS 过渡，不影响鼠标命中）
    animateDuration: 140, // 渐变时长（ms）
    lineNumbersOnlyAtCursor: true, // 只显示光标行的行号（行号列宽度保留，不改布局）
    cacheSize: 300, // 每文件宽度缓存条数上限
  };
  var cfg = {};
  for (var dk in DEFAULTS) cfg[dk] = DEFAULTS[dk];

  var STORE_KEY = "fitcode.cols.v1";
  var LN_RENDER_ON = 1; // Monaco RenderLineNumbersType.On

  function clampNum(v, d, lo, hi) {
    var n = typeof v === "number" && isFinite(v) ? v : d;
    return Math.min(hi, Math.max(lo, n));
  }
  function applyConfig(j) {
    // 缺省字段沿用当前值（手改 json 只写一项时不会把其它设置重置）
    var next = {
      center: typeof j.center === "boolean" ? j.center : cfg.center,
      minTextWidth: clampNum(j.minTextWidth, cfg.minTextWidth, 0, 4000),
      paddingRight: clampNum(j.paddingRight, cfg.paddingRight, 0, 400),
      animate: typeof j.animate === "boolean" ? j.animate : cfg.animate,
      animateDuration: clampNum(
        j.animateDuration,
        cfg.animateDuration,
        0,
        1000,
      ),
      lineNumbersOnlyAtCursor:
        typeof j.lineNumbersOnlyAtCursor === "boolean"
          ? j.lineNumbersOnlyAtCursor
          : cfg.lineNumbersOnlyAtCursor,
      cacheSize: clampNum(j.cacheSize, cfg.cacheSize, 10, 5000),
    };
    var changed = false,
      lnChanged = false,
      animChanged = false;
    for (var k in next) {
      if (cfg[k] !== next[k]) {
        changed = true;
        if (k === "lineNumbersOnlyAtCursor") lnChanged = true;
        if (k === "animate" || k === "animateDuration") animChanged = true;
      }
    }
    if (!changed) return;
    cfg = next;
    if (animChanged) injectStyle(true);
    mainEditors().forEach(function (ed) {
      if (lnChanged) scheduleLineNumbers(ed);
      applyPad(ed, false); // 配置变了重算一次（居中开关/最小宽度/留白都可能影响 pad）
    });
  }

  var cfgUrl = null,
    cfgLoading = false;
  function loadConfig() {
    if (!cfgUrl) {
      try {
        cfgUrl = new URL(CFG_REL, document.baseURI).href;
      } catch (e) {
        return;
      }
    }
    if (cfgLoading) return;
    cfgLoading = true;
    fetch(cfgUrl, { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (j) {
        cfgLoading = false;
        if (j) applyConfig(j);
      })
      .catch(function () {
        cfgLoading = false;
      });
  }

  // ---------- 列数计算（与扩展侧同逻辑：tab 展开、全角计 2、去尾随空白） ----------
  function isWide(cp) {
    return (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    );
  }
  function lineVisualCols(line, tabSize) {
    var col = 0,
      lastNonBlank = 0;
    for (var i = 0; i < line.length; i++) {
      var cp = line.codePointAt(i);
      if (cp > 0xffff) i++;
      if (cp === 9) {
        col += tabSize - (col % tabSize);
        continue;
      }
      col += isWide(cp) ? 2 : 1;
      if (cp !== 32) lastNonBlank = col;
    }
    return lastNonBlank;
  }

  // 扫描全部行：先用 getLineLength 拿字符数上界（O(1)/行、不复制文本），
  // 上界追不上当前最佳的行直接跳过 —— 长文件不用把全文读出来
  function scanCols(model, tabSize) {
    var n = model.getLineCount();
    var perChar = Math.max(2, tabSize); // 单字符最多占的列数（tab 可能到 tabSize）
    var best = 0;
    for (var i = 1; i <= n; i++) {
      var len;
      try {
        len = model.getLineLength(i);
      } catch (e) {
        continue;
      }
      if (len === 0 || len * perChar < best) continue;
      var c = lineVisualCols(model.getLineContent(i), tabSize);
      if (c > best) best = c;
    }
    return best;
  }

  // ---------- 缓存：内存（按 model） + 持久（按 uri） ----------
  var mem = new Map();
  var store = (function () {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch (e) {
      return {};
    }
  })();
  var saveTimer = 0;
  function saveStore() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        var keys = Object.keys(store);
        if (keys.length > cfg.cacheSize) {
          keys.sort(function (a, b) {
            return (store[a].t || 0) - (store[b].t || 0);
          });
          keys.slice(0, keys.length - cfg.cacheSize).forEach(function (k) {
            delete store[k];
          });
        }
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
      } catch (e) {
        /* 配额或隐私模式，忽略 */
      }
    }, 800);
  }
  function uriOf(model) {
    try {
      return model.uri ? model.uri.toString() : null;
    } catch (e) {
      return null;
    }
  }
  // 指纹：行数 + 字符总数 + 首尾行采样。三项都对上才复用缓存（默认认为内容没变）
  function fingerprint(model) {
    var n = model.getLineCount();
    var head = "",
      tail = "";
    try {
      head = model.getLineContent(1).slice(0, 200);
    } catch (e) {
      /* ignore */
    }
    try {
      tail = model.getLineContent(n).slice(-200);
    } catch (e) {
      /* ignore */
    }
    return { lines: n, length: model.getValueLength(), head: head, tail: tail };
  }

  function colsFor(model) {
    if (!model) return 0;
    var ver = model.getVersionId();
    var hit = mem.get(model);
    if (hit && hit.ver === ver) return hit.cols;

    var tabSize = 4;
    try {
      var t = model.getOptions().tabSize;
      if (t > 0 && t <= 16) tabSize = t;
    } catch (e) {
      /* ignore */
    }

    var uri = uriOf(model);
    var fp = fingerprint(model);
    var rec = uri && store[uri];
    if (
      rec &&
      rec.lines === fp.lines &&
      rec.length === fp.length &&
      rec.head === fp.head &&
      rec.tail === fp.tail
    ) {
      mem.set(model, { ver: ver, cols: rec.cols });
      rec.t = Date.now();
      saveStore();
      return rec.cols;
    }

    var cols = scanCols(model, tabSize);
    mem.set(model, { ver: ver, cols: cols });
    if (uri) {
      store[uri] = {
        lines: fp.lines,
        length: fp.length,
        head: fp.head,
        tail: fp.tail,
        cols: cols,
        t: Date.now(),
      };
      saveStore();
    }
    return cols;
  }

  function charWidth(dom) {
    var ref = dom.querySelector(".view-lines") || dom;
    var cs = getComputedStyle(ref);
    var ctx =
      charWidth._ctx ||
      (charWidth._ctx = document.createElement("canvas").getContext("2d"));
    ctx.font =
      cs.fontStyle +
      " " +
      cs.fontWeight +
      " " +
      cs.fontSize +
      " " +
      cs.fontFamily;
    if ("letterSpacing" in ctx)
      ctx.letterSpacing =
        cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing;
    var w = ctx.measureText("00000000000000000000").width / 20;
    return w > 0 ? w : parseFloat(cs.fontSize) * 0.6;
  }

  // 主编辑器 = 挂在编辑器组里的实例；chat 输入框等辅助编辑器不参与
  function mainEditors() {
    var out = [];
    var set = window.__ftEditors;
    if (!set) return out;
    set.forEach(function (ed) {
      try {
        var d = ed.getDomNode();
        if (d && d.isConnected && d.closest(".editor-group-container"))
          out.push(ed);
      } catch (e) {
        /* disposed */
      }
    });
    return out;
  }

  // wordWrap 生效值：与 bundle 补丁同一套解析（override2 → override1 → wordWrap）
  function wordWrapOf(ed) {
    try {
      var w = ed.getOption(156);
      if (w === "inherit") w = ed.getOption(155);
      if (w === "inherit") w = ed.getOption(151);
      return w || "off";
    } catch (e) {
      return "off";
    }
  }

  function computePadFor(ed) {
    if (!cfg.center) return 0; // 回归原生布局
    var dom = ed.getDomNode();
    var host = dom.parentElement;
    var avail = host ? host.clientWidth : 0;
    if (avail < 400) return 0; // 与补丁门控（outerWidth>=400）保持一致
    var wrap = wordWrapOf(ed);
    if (wrap === "wordWrapColumn") return 0; // 固定列宽模式，不参与居中（与补丁门控一致）
    var li = ed.getLayoutInfo();
    var gutter =
      li.glyphMarginWidth + li.lineNumbersWidth + li.decorationsWidth;
    var mm = li.minimap.renderMinimap !== 0 ? li.minimap.minimapWidth : 0;
    var vsb = li.verticalScrollbarWidth;
    var cw = charWidth(dom);
    var natural = colsFor(ed.getModel()) * cw + cfg.paddingRight; // 正文自然宽度
    var minText = Math.max(0, cfg.minTextWidth - gutter); // 最小宽度；自动换行时兼作阅读欄宽
    // 不换行：放得下就居中，放不下自动撑满 + 横向滚动；
    // 自动换行：没有“自然宽度”可言（每行都能折），用 minTextWidth 当欄宽，
    // 内容本身就窄时仍按自身宽度居中，不把一段短文本拉成固定欄
    var target = wrap === "off" ? Math.max(natural, minText) : Math.min(natural, minText);
    return Math.max(0, Math.floor((avail - gutter - mm - vsb - target) / 2));
  }

  function setRuler(ed, pad) {
    try {
      ed.updateOptions({
        rulers: [
          { column: Math.min(Math.max(pad, 0), 10000), color: "transparent" },
        ],
      });
    } catch (e) {
      /* ignore */
    }
  }
  function rulerPad(ed) {
    try {
      var rr = ed.getOption(117);
      return rr && rr.length ? rr[0].column || 0 : 0;
    } catch (e) {
      return 0;
    }
  }

  // ---------- 渐变：只在“内容宽度变了”的场合临时挂过渡类，避免缩放面板时拖泥带水 ----------
  function injectStyle(rebuild) {
    var old = document.getElementById("ft-style");
    if (old && !rebuild) return;
    if (old) old.remove();
    var s = document.createElement("style");
    s.id = "ft-style";
    s.textContent =
      ".monaco-editor.ft-anim .editor-scrollable,\n" +
      ".monaco-editor.ft-anim .margin-view-overlays,\n" +
      ".monaco-editor.ft-anim .glyph-margin,\n" +
      ".monaco-editor.ft-anim .minimap,\n" +
      ".monaco-editor.ft-anim .decorationsOverviewRuler,\n" +
      ".monaco-editor.ft-anim .scrollbar.vertical" +
      " { transition: left " +
      cfg.animateDuration +
      "ms ease, width " +
      cfg.animateDuration +
      "ms ease; }";
    try {
      document.head.appendChild(s);
    } catch (e) {
      /* ignore */
    }
  }

  function applyPad(ed, animate) {
    var pad = computePadFor(ed);
    if (rulerPad(ed) === pad) return;
    if (!cfg.animate || !animate || cfg.animateDuration <= 0) {
      setRuler(ed, pad);
      return;
    }
    var dom;
    try {
      dom = ed.getDomNode();
      dom.classList.add("ft-anim");
    } catch (e) {
      setRuler(ed, pad);
      return;
    }
    setRuler(ed, pad);
    setTimeout(function () {
      try {
        dom.classList.remove("ft-anim");
      } catch (e) {
        /* ignore */
      }
    }, cfg.animateDuration + 60);
  }

  // ---------- 事件驱动：切文件 / 改内容 / 改布局都立刻重算 ----------
  var attached = new WeakSet();
  function attach(ed) {
    if (attached.has(ed)) return;
    attached.add(ed);
    var debounce = 0;
    try {
      // 切文件：同步重算（赶在下一帧绘制前写好 rulers，不会先闪成旧宽度），并做渐变
      ed.onDidChangeModel(function () {
        applyPad(ed, true);
        scheduleLineNumbers(ed);
      });
      // 改内容：防抖后再算，顺便写缓存
      ed.onDidChangeModelContent(function () {
        clearTimeout(debounce);
        debounce = setTimeout(function () {
          applyPad(ed, false);
        }, 150);
      });
      // 面板尺寸变化（分屏、缩放窗口）：不要动画
      ed.onDidLayoutChange(function () {
        applyPad(ed, false);
        scheduleLineNumbers(ed);
      });
      // 字体 / wordWrap / tabSize 等配置变化
      ed.onDidChangeConfiguration(function () {
        applyPad(ed, false);
      });
      // 光标移动 / 滚动 / 换文件 / 改内容 / 布局变化 → 重算“哪些行号可见”
      ed.onDidChangeCursorSelection(function () {
        scheduleLineNumbers(ed);
      });
      ed.onDidScrollChange(function () {
        scheduleLineNumbers(ed);
      });
    } catch (e) {
      /* ignore */
    }
  }

  // ---------- 行号：只显示光标所在行（多光标则全部显示） ----------
  // 只改 opacity，不动 gutter 宽度 → 正文位置稳定，不会跟着光标左右跳。
  // 仅在 editor.lineNumbers === 'on' 时接管；off/relative/interval 保持原生行为。
  // 'on' 模式下每个 .line-numbers 元素的文本就是行号本身，直接拿来判定，
  // 不依赖 top/transform 之类的定位实现（新版 Monaco 已经不用 style.top 了）。
  function lineNumbersFor(ed) {
    if (!cfg.lineNumbersOnlyAtCursor) {
      // 关掉这个功能时，把之前隐藏的行号还原
      try {
        var ov = ed.getDomNode().querySelector(".margin-view-overlays");
        if (ov) {
          var all = ov.querySelectorAll(".line-numbers");
          for (var a = 0; a < all.length; a++)
            if (all[a].style.opacity) all[a].style.opacity = "";
        }
      } catch (e) {
        /* ignore */
      }
      return;
    }
    var renderType = 0;
    try {
      renderType = ed.getOption(76).renderType;
    } catch (e) {
      return;
    }
    if (renderType !== LN_RENDER_ON) return;

    var els;
    try {
      var overlay = ed.getDomNode().querySelector(".margin-view-overlays");
      if (!overlay) return;
      els = overlay.querySelectorAll(".line-numbers");
    } catch (e) {
      return;
    }
    if (!els.length) return;

    var cursors = new Set();
    try {
      ed.getSelections().forEach(function (sel) {
        cursors.add(sel.positionLineNumber);
      });
    } catch (e) {
      return;
    }

    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var ln = parseInt((el.textContent || "").trim(), 10);
      var want = ln === ln && cursors.has(ln) ? "" : "0"; // NaN（非纯数字）时保持可见
      if (el.style.opacity !== want) el.style.opacity = want;
    }
  }

  var lnQueue = new WeakSet();
  function scheduleLineNumbers(ed) {
    if (lnQueue.has(ed)) return;
    lnQueue.add(ed);
    requestAnimationFrame(function () {
      lnQueue.delete(ed);
      lineNumbersFor(ed);
    });
  }

  function tick() {
    var eds = mainEditors();
    for (var i = 0; i < eds.length; i++) {
      attach(eds[i]);
      applyPad(eds[i], false);
      scheduleLineNumbers(eds[i]);
    }
  }

  injectStyle();
  loadConfig();
  setInterval(loadConfig, CFG_POLL_MS);
  window.addEventListener("focus", loadConfig);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) loadConfig();
  });
  setInterval(tick, 1000); // 只做兜底 + 发现新编辑器
  tick();
})();
