/* ---------------------------------------------------------------
   Center Editor v5.1 —— 渲染层（每编辑器独立自适应居中·rulers 载体）

   协议：bundle 补丁的 computeLayout 从【本编辑器自己的 rulers 选项】
   （EditorOption 117，inject 通过 updateOptions({rulers:[{column:pad,
   color:'transparent'}]}) 写入）读取内缩量，应用到
   glyphMargin/行号/装饰/contentLeft（+pad）、contentWidth（-2*pad）、
   minimapLeft（-pad）。rulers 是每编辑器独立的真实 option → 分屏互不干扰；
   改 rulers 本身就会触发布局重算（无需额外触发器）；透明色不可见。

   本脚本职责：对每个主编辑器，读自己的 model 全文算最长行视觉列数，
   按自己的面板宽算出 pad，写入 rulers。

   纯自适应：内容放得下就居中，放不下自动撑满 + 横向滚动。无阈值。
   --------------------------------------------------------------- */
(function () {
	'use strict';
	if (window.__ceLoaded) return;
	window.__ceLoaded = true;

	var MIN_TEXT_WIDTH = 640; // 最小正文宽（原需求："有一个最小宽度"）
	var PAD_RIGHT = 20;       // 正文右侧额外留白（原需求）
	var colsCache = new Map(); // model → { ver, cols }

	// ---------- 列数计算（与扩展侧同逻辑：tab 展开、全角计 2、去尾随空白） ----------
	function isWide(cp) {
		return (
			(cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
			(cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
			(cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f9ff) ||
			(cp >= 0x20000 && cp <= 0x3fffd)
		);
	}
	function maxVisualColumns(text, tabSize) {
		var max = 0, col = 0, lastNonBlank = 0;
		for (var i = 0; i < text.length; i++) {
			var cp = text.codePointAt(i);
			if (cp > 0xffff) i++;
			if (cp === 10) { if (lastNonBlank > max) max = lastNonBlank; col = 0; lastNonBlank = 0; continue; }
			if (cp === 13) continue;
			if (cp === 9) { col += tabSize - (col % tabSize); continue; }
			col += isWide(cp) ? 2 : 1;
			if (cp !== 32) lastNonBlank = col;
		}
		if (lastNonBlank > max) max = lastNonBlank;
		return max;
	}
	function colsFor(model) {
		var ver = model.getVersionId();
		var hit = colsCache.get(model);
		if (hit && hit.ver === ver) return hit.cols;
		var text = model.getValue();
		var tabSize = 4;
		try { var t = model.getOptions().tabSize; if (t > 0 && t <= 16) tabSize = t; } catch (e) {}
		var cols = maxVisualColumns(text, tabSize);
		if (colsCache.size > 50) colsCache.clear();
		colsCache.set(model, { ver: ver, cols: cols });
		return cols;
	}

	function charWidth(dom) {
		var ref = dom.querySelector('.view-lines') || dom;
		var cs = getComputedStyle(ref);
		var ctx = charWidth._ctx || (charWidth._ctx = document.createElement('canvas').getContext('2d'));
		ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
		if ('letterSpacing' in ctx) ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
		var w = ctx.measureText('00000000000000000000').width / 20;
		return w > 0 ? w : parseFloat(cs.fontSize) * 0.6;
	}

	// 主编辑器 = 挂在编辑器组里的实例；chat 输入框等辅助编辑器不参与
	function mainEditors() {
		var out = [];
		var set = window.__ceEditors;
		if (!set) return out;
		set.forEach(function (ed) {
			try {
				var d = ed.getDomNode();
				if (d && d.isConnected && d.closest('.editor-group-container')) out.push(ed);
			} catch (e) { /* disposed */ }
		});
		return out;
	}

	function computePadFor(ed) {
		var dom = ed.getDomNode();
		var host = dom.parentElement;
		var avail = host ? host.clientWidth : 0;
		if (avail < 400) return 0; // 与补丁门控（outerWidth>=400）保持一致
		var li = ed.getLayoutInfo();
		var gutter = li.glyphMarginWidth + li.lineNumbersWidth + li.decorationsWidth;
		var mm = li.minimap.renderMinimap !== 0 ? li.minimap.minimapWidth : 0;
		var vsb = li.verticalScrollbarWidth;
		var cw = charWidth(dom);
		var target = colsFor(ed.getModel()) * cw + PAD_RIGHT;   // 想要的正文可视宽
		var minText = Math.max(0, MIN_TEXT_WIDTH - gutter);      // 最小宽度
		if (target < minText) target = minText;
		// 纯自适应：放得下就居中，放不下自动撑满 + 横向滚动
		return Math.max(0, Math.floor((avail - gutter - mm - vsb - target) / 2));
	}

	function setRuler(ed, pad) {
		try {
			ed.updateOptions({ rulers: [{ column: Math.min(Math.max(pad, 0), 10000), color: 'transparent' }] });
		} catch (e) { /* ignore */ }
	}
	function rulerPad(ed) {
		try { var rr = ed.getOption(117); return rr && rr.length ? (rr[0].column || 0) : 0; } catch (e) { return 0; }
	}

	function tick() {
		var eds = mainEditors();
		for (var i = 0; i < eds.length; i++) {
			var ed = eds[i];
			var pad = computePadFor(ed);
			var cur = rulerPad(ed);
			if (cur !== pad) setRuler(ed, pad); // rulers 变化 → 选项重算 → 布局重算（pad 应用）
		}
	}

	setInterval(function () { tick(); }, 700);
	tick();
})();
