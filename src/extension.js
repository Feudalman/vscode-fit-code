const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const START = '<!-- !! CENTER-EDITOR-START !! -->';
const END = '<!-- !! CENTER-EDITOR-END !! -->';
const CSP_COMMENT = /<!-- !! CENTER-EDITOR-CSP ([A-Za-z0-9+/=]*) !! -->/;
const CSP_META = /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/;
const OTHER_BLOCK = /<!-- !! VSCODE-CUSTOM-CSS-START !! -->[\s\S]*?<!-- !! VSCODE-CUSTOM-CSS-END !! -->\n*/;
const OTHER_SESSION = /<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID [\w-]+ !! -->\n*/g;

// workbench.desktop.main.js 里给 CodeEditorWidget 的工厂方法加一行，把 editor 实例暴露给渲染层
// 原样（压缩后）：_createConfiguration(e,t,i,n){return new ode(e,t,i,this._domElement,n)}
const BUNDLE_ANCHOR = /_createConfiguration\((\w+),(\w+),(\w+),(\w+)\)\{return new ([\w$]+)\(\1,\2,\3,this\._domElement,\4\)\}/;
const BUNDLE_MARKER = '__ceEditors';
const BUNDLE_FLAG = 'window.__ceBundlePatched=1;';
// 历史方案（已废弃）：把注入脚本作为外部 <script> 从 bundle 里加载——
// CSP 带 require-trusted-types-for 'script'，字符串赋给 script.src 会被 TrustedScriptURL 拦掉。
// 现在注入仍走 workbench.html 内联（因此 html 必须去掉 CSP meta，原文以 base64 注释留档）。
const LEGACY_LOADER = 'var __ceLoader=document.createElement';
// 兜底锚点：updateOptions 一定会被调用（配置变化 / 切语言等）
const BUNDLE_ANCHOR2 = /updateOptions\((\w+)\)\{this\._configuration\.updateOptions\(\1\|\|\{\}\)\}/;
// 第三处：门控(__ceGate) + 读本编辑器自己的 rulers（EditorOption 117，inject.js 写入），
// 返回值里按【本编辑器自己的宽度】独立计算内缩量 __ceP 并应用到
// glyphMargin/行号/装饰/contentLeft（+__ceP）、contentWidth（-2*__ceP）。minimap 保持原生位置。
const BUNDLE_ANCHOR3 = /computeLayout\((\w+),(\w+)\)\{let (\w+)=\2\.outerWidth\|0/;
const BUNDLE_ANCHOR3R = /\{width:(\w+),height:(\w+),glyphMarginLeft:(\w+),glyphMarginWidth:(\w+),glyphMarginDecorationLaneCount:([\w$.]+),lineNumbersLeft:(\w+),lineNumbersWidth:(\w+),decorationsLeft:(\w+),decorationsWidth:(\w+),contentLeft:(\w+),contentWidth:(\w+),minimap:(\w+)/;
const BUNDLE_MARKER3 = '__ceGate';
// 第四处（滚动条/minimap 钉右）：EditorScrollbar 的容器就是【正文所在的容器】——
// lines-content、decorationsOverviewRuler、竖滚动条都是它的子元素，正文位置 = 它的 left。
// 补丁3 缩小 contentWidth 后，这个容器右边缘左移 pad → 滚动条跟着正文居中。
// 所以：left 绝对不能动（动它正文会一起左移），只把 width 加 pad，让右边缘铺回编辑器最右。
const BUNDLE_ANCHOR4 = /_setLayout\(\)\{let (\w+)=this\._context\.configuration\.options,(\w+)=\1\.get\(168\);this\.scrollbarDomNode\.setLeft\(\2\.contentLeft\),\1\.get\(81\)\.side==="right"\?this\.scrollbarDomNode\.setWidth\(\2\.contentWidth\+\2\.minimap\.minimapWidth\):this\.scrollbarDomNode\.setWidth\(\2\.contentWidth\),this\.scrollbarDomNode\.setHeight\(\2\.height\)\}/;
const BUNDLE_MARKER4 = '__ceSb';
// 历史补丁痕迹（旧版在返回值上做内缩）：检测到则从备份还原后重打
const BUNDLE_LEGACY = /contentLeft:\(__ceCE\?|__ceCE2|__ceCE4/;
// 旧补丁（minimap 跟随内容左移 / 滚动条未钉右缘）→ 也从备份还原后按当前版本重打
const BUNDLE_LEGACY_V5 = /minimapLeft=l\.minimapLeft-__ceP/;
const bundlePathFor = (htmlPath) =>
	path.resolve(path.dirname(htmlPath), '..', '..', '..', 'workbench', 'workbench.desktop.main.js');


/* ------------------------------------------------------------------ */
/* 1. 列数：当前文件最长一行的视觉列数（monospace 列）                  */
/* ------------------------------------------------------------------ */
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

function maxVisualColumns(text, tabSize) {
	let max = 0;
	let col = 0;
	let lastNonBlank = 0;
	for (let i = 0; i < text.length; i++) {
		const cp = text.codePointAt(i);
		if (cp > 0xffff) i++;
		if (cp === 10) {
			if (lastNonBlank > max) max = lastNonBlank;
			col = 0;
			lastNonBlank = 0;
			continue;
		}
		if (cp === 13) continue;
		if (cp === 9) {
			col += tabSize - (col % tabSize);
			continue;
		}
		col += isWide(cp) ? 2 : 1;
		if (cp !== 32) lastNonBlank = col;
	}
	if (lastNonBlank > max) max = lastNonBlank;
	return max;
}

function columnsOfEditor(editor) {
	if (!editor || !editor.document) return 0;
	const doc = editor.document;
	let tabSize = 4;
	try {
		const ts = vscode.workspace.getConfiguration('editor', doc.uri).get('tabSize');
		if (typeof ts === 'number' && ts > 0 && ts <= 16) tabSize = ts;
	} catch (e) { /* ignore */ }
	try {
		return maxVisualColumns(doc.getText(), tabSize);
	} catch (e) {
		return 0;
	}
}

/* ------------------------------------------------------------------ */
/* 2. 信道：一个（被渲染层 CSS 隐藏的）状态栏项 ce:<cols>,<min>,<pad>    */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 3. 打补丁 / 还原 VSCode 的 workbench.html                          */
/* ------------------------------------------------------------------ */
function locateWorkbenchHtml() {
	const appDir = require.main ? path.dirname(require.main.filename) : globalThis._VSCODE_FILE_ROOT;
	if (!appDir) return null;
	const base = path.join(appDir, 'vs', 'code');
	const dirs = ['electron-browser/workbench', 'electron-browser', 'electron-sandbox/workbench', 'electron-sandbox'];
	const files = ['workbench.esm.html', 'workbench.html'];
	for (const d of dirs) for (const f of files) {
		const p = path.join(base, d, f);
		if (fs.existsSync(p)) return p;
	}
	return null;
}

const backupPathFor = (htmlPath) => htmlPath + '.center-editor.bak';

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripPatch(html) {
	let out = html.replace(new RegExp(`${escapeRe(START)}[\\s\\S]*?${escapeRe(END)}\\n*`), '');
	const m = out.match(CSP_COMMENT);
	if (m) out = out.replace(CSP_COMMENT, Buffer.from(m[1], 'base64').toString('utf8'));
	return out;
}

// 老版本（或别的插件）可能已经把 CSP 拆掉了，从同目录的备份文件里找回原始 CSP
function recoverCsp(htmlPath) {
	try {
		const dir = path.dirname(htmlPath);
		for (const f of fs.readdirSync(dir)) {
			if (!f.endsWith('.bak-custom-css') && !f.endsWith('.center-editor.bak')) continue;
			const m = fs.readFileSync(path.join(dir, f), 'utf8').match(CSP_META);
			if (m) return m[0];
		}
	} catch (e) { /* ignore */ }
	return null;
}

const asset = (name) => fs.readFileSync(path.join(__dirname, '..', 'media', name), 'utf8');

async function patchBundle(htmlPath) {
	const bundle = bundlePathFor(htmlPath);
	if (!fs.existsSync(bundle)) return { ok: false, error: '找不到 workbench.desktop.main.js' };
	let src = await fs.promises.readFile(bundle, 'utf8');
	const bak = bundle + '.center-editor.bak';
	// 检测到任何旧版补丁痕迹 → 先从备份还原成干净体再重打，避免新旧补丁叠加
	if (BUNDLE_LEGACY.test(src) || BUNDLE_LEGACY_V5.test(src) || src.includes(LEGACY_LOADER)) {
		if (!fs.existsSync(bak)) return { ok: false, error: '检测到旧版补丁但没有备份，无法安全升级，请手动还原 bundle' };
		src = await fs.promises.readFile(bak, 'utf8');
	}
	if (!fs.existsSync(bak)) await fs.promises.writeFile(bak, src, 'utf8');

	const reg = '(window.__ceEditors||(window.__ceEditors=new Set)).add(this)';
	let changed = false;

	if (!src.includes(BUNDLE_MARKER)) {
		const hits = src.match(new RegExp(BUNDLE_ANCHOR.source, 'g')) || [];
		if (hits.length !== 1) return { ok: false, error: `锚点1匹配 ${hits.length} 处` };
		src = src.replace(
			BUNDLE_ANCHOR,
			'_createConfiguration($1,$2,$3,$4){var __ce=new $5($1,$2,$3,this._domElement,$4);' + reg + ';return __ce}'
		);
		changed = true;
	}
	if (!src.includes(BUNDLE_FLAG)) {
		const hits2 = src.match(new RegExp(BUNDLE_ANCHOR2.source, 'g')) || [];
		if (hits2.length === 1) {
			src = src.replace(BUNDLE_ANCHOR2, 'updateOptions($1){this._configuration.updateOptions($1||{});' + reg + '}');
			changed = true;
		}
		src = BUNDLE_FLAG + src;
		changed = true;
	}
	if (!src.includes(';return __ce}')) return { ok: false, error: '补丁自检失败：return 后缺少右花括号' };
	if (!src.includes(BUNDLE_MARKER3)) {
		const hits3 = src.match(new RegExp(BUNDLE_ANCHOR3.source, 'g')) || [];
		if (hits3.length !== 1) return { ok: false, error: `锚点3头 匹配 ${hits3.length} 处` };
		src = src.replace(
			BUNDLE_ANCHOR3,
			'computeLayout($1,$2){' +
				'var __ceGate=(function(){var w=$1.get(156);w=w==="inherit"?$1.get(155):w;' +
				'w=w==="inherit"?$1.get(151):w;return w==="off"&&$2.outerWidth>=400})();' +
				'var __ceK=$1.get(117)||[];' +
				'var __ceP=(__ceGate&&__ceK.length&&typeof __ceK[0].column==="number")?__ceK[0].column:0;' +
				'let $3=$2.outerWidth|0'
		);
		const hits3r = src.match(new RegExp(BUNDLE_ANCHOR3R.source, 'g')) || [];
		if (hits3r.length !== 1) return { ok: false, error: `锚点3返回 匹配 ${hits3r.length} 处` };
		src = src.replace(
			BUNDLE_ANCHOR3R,
			'{width:$1,height:$2,glyphMarginLeft:$3+__ceP,glyphMarginWidth:$4,glyphMarginDecorationLaneCount:$5,' +
				'lineNumbersLeft:$6+__ceP,lineNumbersWidth:$7,decorationsLeft:$8+__ceP,decorationsWidth:$9,' +
				// minimap 不跟内容左移：右侧 UI 全部钉在右边缘，只有正文/行号居中
				'contentLeft:$10+__ceP,contentWidth:Math.max(1,$11-2*__ceP),minimap:$12'
		);
		changed = true;
	}
	if (!src.includes(BUNDLE_MARKER4)) {
		const hits4 = src.match(new RegExp(BUNDLE_ANCHOR4.source, 'g')) || [];
		if (hits4.length !== 1) return { ok: false, error: `锚点4 匹配 ${hits4.length} 处` };
		src = src.replace(
			BUNDLE_ANCHOR4,
			'_setLayout(){let $1=this._context.configuration.options,$2=$1.get(168);' +
				// 与补丁3 同一门控：wordWrap=off 且宽度≥400 时才认 rulers 里的内缩量
				'var __ceW=$1.get(156);__ceW=__ceW==="inherit"?$1.get(155):__ceW;' +
				'__ceW=__ceW==="inherit"?$1.get(151):__ceW;' +
				'var __ceK=$1.get(117)||[];' +
				'var __ceSb=(__ceW==="off"&&$2.width>=400&&__ceK.length&&typeof __ceK[0].column==="number")?__ceK[0].column:0;' +
				// 左边界不动：正文位置 = 容器 left，动它就等于把正文一起挪走（曾经踩过）
				'this.scrollbarDomNode.setLeft($2.contentLeft),' +
				'$1.get(81).side==="right"?this.scrollbarDomNode.setWidth($2.contentWidth+__ceSb+$2.minimap.minimapWidth)' +
				':this.scrollbarDomNode.setWidth($2.contentWidth+__ceSb),' +
				'this.scrollbarDomNode.setHeight($2.height)}'
		);
		changed = true;
	}
	if (changed) await fs.promises.writeFile(bundle, src, 'utf8');
	return { ok: true, bundle, changed };
}

async function unpatchBundle(htmlPath) {
	const bundle = bundlePathFor(htmlPath);
	const bak = bundle + '.center-editor.bak';
	// 清掉历史方案遗留的外部注入脚本，再还原 bundle
	try { fs.unlinkSync(path.join(path.dirname(bundle), 'center-editor.inject.js')); } catch (e) { /* ignore */ }
	if (fs.existsSync(bak)) {
		await fs.promises.copyFile(bak, bundle);
		await fs.promises.unlink(bak);
		return true;
	}
	return false;
}

async function cmdEnable() {
	const htmlPath = locateWorkbenchHtml();
	if (!htmlPath) {
		vscode.window.showErrorMessage('Center Editor: 找不到 workbench.html');
		return;
	}
	let html = await fs.promises.readFile(htmlPath, 'utf8');
	const bak = backupPathFor(htmlPath);
	const cspInFile = html.match(CSP_META);
	const recoveredCsp = cspInFile ? cspInFile[0] : recoverCsp(htmlPath);

	// 干净状态下先留一份完整原文，禁用时原样还原
	if (!fs.existsSync(bak)) {
		if (cspInFile) {
			await fs.promises.writeFile(bak, html, 'utf8');
		} else if (recoveredCsp) {
			let clean = stripPatch(html).replace(OTHER_BLOCK, '').replace(OTHER_SESSION, '');
			clean = clean.replace('</head>', recoveredCsp + '\n</head>');
			await fs.promises.writeFile(bak, clean, 'utf8');
		}
	}

	html = stripPatch(html);
	let removedOther = false;
	if (OTHER_BLOCK.test(html)) {
		removedOther = true;
		html = html.replace(OTHER_BLOCK, '').replace(OTHER_SESSION, '');
	}

	// 内联 <script> 必须去掉 CSP。⚠️ 顺序：先 stripPatch（它会把注释里的 meta 还原回正文），
	// 再取 CSP、再用全局正则把正文里所有 meta 删干净——否则残留的 meta 会静默拦掉注入脚本。
	const cspAfter = html.match(CSP_META);
	const csp = cspAfter ? cspAfter[0] : recoveredCsp;
	html = html.replace(new RegExp(CSP_META.source, 'g'), '');
	const savedCsp = csp ? `<!-- !! CENTER-EDITOR-CSP ${Buffer.from(csp, 'utf8').toString('base64')} !! -->\n` : '';

	const block = `${savedCsp}${START}\n<script>${asset('inject.js')}</script>\n${END}\n</head>`;
	html = html.replace('</head>', block);

	const bp = await patchBundle(htmlPath);
	if (!bp.ok) {
		vscode.window.showErrorMessage('Center Editor: ' + bp.error);
		return;
	}
	try {
		await fs.promises.writeFile(htmlPath, html, 'utf8');
	} catch (e) {
		vscode.window.showErrorMessage('Center Editor: 写入失败（权限不足？）' + e.message);
		return;
	}
	try {
		await vscode.workspace.getConfiguration('centerEditor').update('enabled', true, vscode.ConfigurationTarget.Global);
	} catch (e) { /* ignore */ }
	const msg = 'Center Editor 已写入，需要重载窗口生效。' + (removedOther ? '（已清除之前 Custom CSS 的注入）' : '');
	const pick = await vscode.window.showInformationMessage(msg, '重载窗口');
	if (pick === '重载窗口') vscode.commands.executeCommand('workbench.action.reloadWindow');
}

async function cmdDisable() {
	const htmlPath = locateWorkbenchHtml();
	if (!htmlPath) return;
	// 还原 html（万一还是旧版留下的内联注入块）
	const bak = backupPathFor(htmlPath);
	if (fs.existsSync(bak)) {
		await fs.promises.copyFile(bak, htmlPath);
		await fs.promises.unlink(bak);
	} else {
		const html = await fs.promises.readFile(htmlPath, 'utf8');
		if (html.includes(START)) await fs.promises.writeFile(htmlPath, stripPatch(html), 'utf8');
	}
	await unpatchBundle(htmlPath);
	try {
		await vscode.workspace.getConfiguration('centerEditor').update('enabled', false, vscode.ConfigurationTarget.Global);
	} catch (e) { /* ignore */ }
	const pick = await vscode.window.showInformationMessage('Center Editor 已还原，需重载窗口。', '重载窗口');
	if (pick === '重载窗口') vscode.commands.executeCommand('workbench.action.reloadWindow');
}

async function cmdStatus() {
	const htmlPath = locateWorkbenchHtml();
	const html = htmlPath ? await fs.promises.readFile(htmlPath, 'utf8') : '';
	const cols = vscode.window.activeTextEditor ? columnsOfEditor(vscode.window.activeTextEditor) : 0;
	const bundle = htmlPath ? bundlePathFor(htmlPath) : '';
	const bundleSrc = bundle && fs.existsSync(bundle) ? fs.readFileSync(bundle, 'utf8') : '';
	const lines = [
		`bundle 已打补丁: ${bundleSrc.includes(BUNDLE_MARKER) ? '是' : '否'}`,
		`滚动条/minimap 钉右: ${bundleSrc.includes(BUNDLE_MARKER4) ? '是' : '否'}`,
		`html 内联注入块: ${html.includes(START) ? '有' : '无'}`,
		`html 里残留 CSP meta: ${(html.match(new RegExp(CSP_META.source, 'g')) || []).length}`,
		`bundle 备份: ${bundle && fs.existsSync(bundle + '.center-editor.bak') ? '有' : '无'}`,
		`当前文件最长行: ${cols || '-'} 列`,
		`workbench.html: ${htmlPath || '未找到'}`,
	];
	vscode.window.showInformationMessage('Center Editor — ' + lines.join('\n'), { modal: true });
}

/* ------------------------------------------------------------------ */
function activate(context) {
	// 仅开发隔离实例使用：常驻监视 /tmp/ce-work/AUTO_SPLIT 标记，组数<2 时自动分屏（E2E 用）
	try {
		const fsp = require('fs');
		setInterval(() => {
			try {
				if (!fsp.existsSync('/tmp/ce-work/AUTO_SPLIT')) return;
				if (vscode.window.tabGroups.all.length >= 2) { fsp.rmSync('/tmp/ce-work/AUTO_SPLIT'); return; }
				vscode.commands.executeCommand('workbench.action.splitEditor').catch(() => {});
			} catch {}
		}, 2000);
	} catch {}


	context.subscriptions.push(vscode.commands.registerCommand('centerEditor.enable', cmdEnable));
	context.subscriptions.push(vscode.commands.registerCommand('centerEditor.disable', cmdDisable));
	context.subscriptions.push(vscode.commands.registerCommand('centerEditor.status', cmdStatus));
}

function deactivate() {}

exports.activate = activate;
exports.deactivate = deactivate;
