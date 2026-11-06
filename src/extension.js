const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

// 文案：走 VSCode 官方 l10n。源码里写英文，英文本身就是 key（fallback 永远是英文），
// 其它语言放在 l10n/bundle.l10n.<locale>.json —— 加语言只加 json，不改代码。
// 「设置/命令」的清单文案在 package.nls*.json 里，是另一套（同名 key 不同文件，别混）。
// 老版本 VSCode 没有 vscode.l10n（< 1.73）时退回英文原文。
function t(msg, ...args) {
  try {
    if (vscode.l10n && typeof vscode.l10n.t === "function")
      return vscode.l10n.t(msg, ...args);
  } catch (e) {
    /* 落到下面的占位符替换 */
  }
  return String(msg).replace(/\{(\d+)\}/g, (m, i) =>
    args[i] === undefined ? m : String(args[i]),
  );
}

const START = "<!-- !! FITCODE-START !! -->";
const END = "<!-- !! FITCODE-END !! -->";
const CSP_COMMENT = /<!-- !! FITCODE-CSP ([A-Za-z0-9+/=]*) !! -->/;
// 旧名字（Center Editor 时代）留下的痕迹：只用于识别、清理、迁移，不要删
const LEGACY_START = "<!-- !! CENTER-EDITOR-START !! -->";
const LEGACY_END = "<!-- !! CENTER-EDITOR-END !! -->";
const LEGACY_CSP_COMMENT = /<!-- !! CENTER-EDITOR-CSP ([A-Za-z0-9+/=]*) !! -->/;
const LEGACY_BAK_SUFFIX = ".center-editor.bak";
const LEGACY_CONFIG_FILE = "center-editor.config.json";
const LEGACY_INJECT_FILE = "center-editor.inject.js";
const CSP_META = /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/;
const OTHER_BLOCK =
  /<!-- !! VSCODE-CUSTOM-CSS-START !! -->[\s\S]*?<!-- !! VSCODE-CUSTOM-CSS-END !! -->\n*/;
const OTHER_SESSION = /<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID [\w-]+ !! -->\n*/g;

// workbench.desktop.main.js 里给 CodeEditorWidget 的工厂方法加一行，把 editor 实例暴露给渲染层
// 原样（压缩后）：_createConfiguration(e,t,i,n){return new ode(e,t,i,this._domElement,n)}
const BUNDLE_ANCHOR =
  /_createConfiguration\((\w+),(\w+),(\w+),(\w+)\)\{return new ([\w$]+)\(\1,\2,\3,this\._domElement,\4\)\}/;
const BUNDLE_MARKER = "__ftEditors";
const BUNDLE_FLAG = "window.__ftBundlePatched=1;";
// 历史方案（已废弃）：把注入脚本作为外部 <script> 从 bundle 里加载——
// CSP 带 require-trusted-types-for 'script'，字符串赋给 script.src 会被 TrustedScriptURL 拦掉。
// 现在注入仍走 workbench.html 内联（因此 html 必须去掉 CSP meta，原文以 base64 注释留档）。
const LEGACY_LOADER = "var __ceLoader=document.createElement";
// 兜底锚点：updateOptions 一定会被调用（配置变化 / 切语言等）
const BUNDLE_ANCHOR2 =
  /updateOptions\((\w+)\)\{this\._configuration\.updateOptions\(\1\|\|\{\}\)\}/;
// 第三处：门控(__ftGate) + 读本编辑器自己的 rulers（EditorOption 117，inject.js 写入），
// 返回值里按【本编辑器自己的宽度】独立计算内缩量 __ftP 并应用到
// glyphMargin/行号/装饰/contentLeft（+__ftP）、contentWidth（-2*__ftP）。minimap 保持原生位置。
const BUNDLE_ANCHOR3 =
  /computeLayout\((\w+),(\w+)\)\{let (\w+)=\2\.outerWidth\|0/;
const BUNDLE_ANCHOR3R =
  /\{width:(\w+),height:(\w+),glyphMarginLeft:(\w+),glyphMarginWidth:(\w+),glyphMarginDecorationLaneCount:([\w$.]+),lineNumbersLeft:(\w+),lineNumbersWidth:(\w+),decorationsLeft:(\w+),decorationsWidth:(\w+),contentLeft:(\w+),contentWidth:(\w+),minimap:(\w+)/;
const BUNDLE_MARKER3 = "__ftGate";
// 第四处（滚动条/minimap 钉右）：EditorScrollbar 的容器就是【正文所在的容器】——
// lines-content、decorationsOverviewRuler、竖滚动条都是它的子元素，正文位置 = 它的 left。
// 补丁3 缩小 contentWidth 后，这个容器右边缘左移 pad → 滚动条跟着正文居中。
// 所以：left 绝对不能动（动它正文会一起左移），只把 width 加 pad，让右边缘铺回编辑器最右。
const BUNDLE_ANCHOR4 =
  /_setLayout\(\)\{let (\w+)=this\._context\.configuration\.options,(\w+)=\1\.get\(168\);this\.scrollbarDomNode\.setLeft\(\2\.contentLeft\),\1\.get\(81\)\.side==="right"\?this\.scrollbarDomNode\.setWidth\(\2\.contentWidth\+\2\.minimap\.minimapWidth\):this\.scrollbarDomNode\.setWidth\(\2\.contentWidth\),this\.scrollbarDomNode\.setHeight\(\2\.height\)\}/;
const BUNDLE_MARKER4 = "__ftSb";
// 渲染层读不到 VSCode 的设置，所以扩展把 fitcode.* 写成 json 放在 bundle 旁边，
// 渲染层（media/inject.js）定时拉取 → 改设置 1~2 秒内生效，不用重跑「启用」。
const RUNTIME_CONFIG_FILE = "fitcode.config.json";
// 历史补丁痕迹（旧版在返回值上做内缩）：检测到则从备份还原后重打
const BUNDLE_LEGACY = /contentLeft:\(__ceCE\?|__ceCE2|__ceCE4/;
// 旧补丁（minimap 跟随内容左移 / 滚动条未钉右缘）→ 也从备份还原后按当前版本重打
const BUNDLE_LEGACY_V5 = /minimapLeft=l\.minimapLeft-__ceP/;
// 旧名字的补丁标记：出现任意一个就说明是旧版打的补丁
const LEGACY_BUNDLE_MARKS = [
  "__ceEditors",
  "__ceGate",
  "__ceSb",
  "__ceBundlePatched",
];
const bundlePathFor = (htmlPath) =>
  path.resolve(
    path.dirname(htmlPath),
    "..",
    "..",
    "..",
    "workbench",
    "workbench.desktop.main.js",
  );

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
    const ts = vscode.workspace
      .getConfiguration("editor", doc.uri)
      .get("tabSize");
    if (typeof ts === "number" && ts > 0 && ts <= 16) tabSize = ts;
  } catch (e) {
    /* ignore */
  }
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
  // 允许外部指定安装目录的 out（test/apply.cjs 在 VSCode 之外跑命令时用）
  const appDir =
    process.env.FITCODE_APP_ROOT ||
    (require.main
      ? path.dirname(require.main.filename)
      : globalThis._VSCODE_FILE_ROOT);
  if (!appDir) return null;
  const base = path.join(appDir, "vs", "code");
  const dirs = [
    "electron-browser/workbench",
    "electron-browser",
    "electron-sandbox/workbench",
    "electron-sandbox",
  ];
  const files = ["workbench.esm.html", "workbench.html"];
  for (const d of dirs)
    for (const f of files) {
      const p = path.join(base, d, f);
      if (fs.existsSync(p)) return p;
    }
  return null;
}

const backupPathFor = (htmlPath) => htmlPath + ".fitcode.bak";

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripPatch(html) {
  let out = html.replace(
    new RegExp(`${escapeRe(START)}[\\s\\S]*?${escapeRe(END)}\\n*`),
    "",
  );
  out = out.replace(
    new RegExp(
      `${escapeRe(LEGACY_START)}[\\s\\S]*?${escapeRe(LEGACY_END)}\\n*`,
    ),
    "",
  );
  let m = out.match(CSP_COMMENT);
  if (m)
    out = out.replace(
      CSP_COMMENT,
      Buffer.from(m[1], "base64").toString("utf8"),
    );
  m = out.match(LEGACY_CSP_COMMENT);
  if (m)
    out = out.replace(
      LEGACY_CSP_COMMENT,
      Buffer.from(m[1], "base64").toString("utf8"),
    );
  return out;
}

// 旧名字的 .bak 迁移成新名字（只在新备份不存在时），这样老安装也能安全还原/重打
function migrateLegacyBackup(target) {
  const legacy = target.replace(/\.fitcode\.bak$/, LEGACY_BAK_SUFFIX);
  try {
    if (!fs.existsSync(target) && fs.existsSync(legacy))
      fs.renameSync(legacy, target);
  } catch (e) {
    /* ignore */
  }
}

// 老版本（或别的插件）可能已经把 CSP 拆掉了，从同目录的备份文件里找回原始 CSP
function recoverCsp(htmlPath) {
  try {
    const dir = path.dirname(htmlPath);
    for (const f of fs.readdirSync(dir)) {
      if (
        !f.endsWith(".bak-custom-css") &&
        !f.endsWith(".fitcode.bak") &&
        !f.endsWith(LEGACY_BAK_SUFFIX)
      )
        continue;
      const m = fs.readFileSync(path.join(dir, f), "utf8").match(CSP_META);
      if (m) return m[0];
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

const asset = (name) =>
  fs.readFileSync(path.join(__dirname, "..", "media", name), "utf8");

async function patchBundle(htmlPath) {
  const bundle = bundlePathFor(htmlPath);
  if (!fs.existsSync(bundle))
    return { ok: false, error: t("Cannot find workbench.desktop.main.js") };
  let src = await fs.promises.readFile(bundle, "utf8");
  const bak = bundle + ".fitcode.bak";
  migrateLegacyBackup(bak);
  // 检测到任何旧版补丁痕迹（旧名字的标记 / 老版本做法）→ 先从备份还原成干净体再重打
  const looksLegacy =
    BUNDLE_LEGACY.test(src) ||
    BUNDLE_LEGACY_V5.test(src) ||
    src.includes(LEGACY_LOADER) ||
    LEGACY_BUNDLE_MARKS.some((m) => src.includes(m));
  if (looksLegacy) {
    if (!fs.existsSync(bak)) {
      return {
        ok: false,
        error: t(
          "Found a previous patch but no backup, so it is unsafe to upgrade. Please restore the bundle manually.",
        ),
      };
    }
    src = await fs.promises.readFile(bak, "utf8");
  }
  if (!fs.existsSync(bak)) await fs.promises.writeFile(bak, src, "utf8");

  const reg = "(window.__ftEditors||(window.__ftEditors=new Set)).add(this)";
  let changed = false;

  if (!src.includes(BUNDLE_MARKER)) {
    const hits = src.match(new RegExp(BUNDLE_ANCHOR.source, "g")) || [];
    if (hits.length !== 1)
      return {
        ok: false,
        error: t("Anchor 1 matched {0} places", hits.length),
      };
    src = src.replace(
      BUNDLE_ANCHOR,
      "_createConfiguration($1,$2,$3,$4){var __ft=new $5($1,$2,$3,this._domElement,$4);" +
        reg +
        ";return __ft}",
    );
    changed = true;
  }
  if (!src.includes(BUNDLE_FLAG)) {
    const hits2 = src.match(new RegExp(BUNDLE_ANCHOR2.source, "g")) || [];
    if (hits2.length === 1) {
      src = src.replace(
        BUNDLE_ANCHOR2,
        "updateOptions($1){this._configuration.updateOptions($1||{});" +
          reg +
          "}",
      );
      changed = true;
    }
    src = BUNDLE_FLAG + src;
    changed = true;
  }
  if (!src.includes(";return __ft}"))
    return {
      ok: false,
      error: t("Patch self-check failed: missing closing brace after return"),
    };
  if (!src.includes(BUNDLE_MARKER3)) {
    const hits3 = src.match(new RegExp(BUNDLE_ANCHOR3.source, "g")) || [];
    if (hits3.length !== 1)
      return {
        ok: false,
        error: t("Anchor 3 head matched {0} places", hits3.length),
      };
    src = src.replace(
      BUNDLE_ANCHOR3,
      "computeLayout($1,$2){" +
        'var __ftGate=(function(){var w=$1.get(156);w=w==="inherit"?$1.get(155):w;' +
        'w=w==="inherit"?$1.get(151):w;return w==="off"&&$2.outerWidth>=400})();' +
        "var __ftK=$1.get(117)||[];" +
        'var __ftP=(__ftGate&&__ftK.length&&typeof __ftK[0].column==="number")?__ftK[0].column:0;' +
        "let $3=$2.outerWidth|0",
    );
    const hits3r = src.match(new RegExp(BUNDLE_ANCHOR3R.source, "g")) || [];
    if (hits3r.length !== 1)
      return {
        ok: false,
        error: t("Anchor 3 return matched {0} places", hits3r.length),
      };
    src = src.replace(
      BUNDLE_ANCHOR3R,
      "{width:$1,height:$2,glyphMarginLeft:$3+__ftP,glyphMarginWidth:$4,glyphMarginDecorationLaneCount:$5," +
        "lineNumbersLeft:$6+__ftP,lineNumbersWidth:$7,decorationsLeft:$8+__ftP,decorationsWidth:$9," +
        // minimap 不跟内容左移：右侧 UI 全部钉在右边缘，只有正文/行号居中
        "contentLeft:$10+__ftP,contentWidth:Math.max(1,$11-2*__ftP),minimap:$12",
    );
    changed = true;
  }
  if (!src.includes(BUNDLE_MARKER4)) {
    const hits4 = src.match(new RegExp(BUNDLE_ANCHOR4.source, "g")) || [];
    if (hits4.length !== 1)
      return {
        ok: false,
        error: t("Anchor 4 matched {0} places", hits4.length),
      };
    src = src.replace(
      BUNDLE_ANCHOR4,
      "_setLayout(){let $1=this._context.configuration.options,$2=$1.get(168);" +
        // 与补丁3 同一门控：wordWrap=off 且宽度≥400 时才认 rulers 里的内缩量
        'var __ftW=$1.get(156);__ftW=__ftW==="inherit"?$1.get(155):__ftW;' +
        '__ftW=__ftW==="inherit"?$1.get(151):__ftW;' +
        "var __ftK=$1.get(117)||[];" +
        'var __ftSb=(__ftW==="off"&&$2.width>=400&&__ftK.length&&typeof __ftK[0].column==="number")?__ftK[0].column:0;' +
        // 左边界不动：正文位置 = 容器 left，动它就等于把正文一起挪走（曾经踩过）
        "this.scrollbarDomNode.setLeft($2.contentLeft)," +
        '$1.get(81).side==="right"?this.scrollbarDomNode.setWidth($2.contentWidth+__ftSb+$2.minimap.minimapWidth)' +
        ":this.scrollbarDomNode.setWidth($2.contentWidth+__ftSb)," +
        "this.scrollbarDomNode.setHeight($2.height)}",
    );
    changed = true;
  }
  if (changed) await fs.promises.writeFile(bundle, src, "utf8");
  return { ok: true, bundle, changed };
}

async function unpatchBundle(htmlPath) {
  const bundle = bundlePathFor(htmlPath);
  const bak = bundle + ".fitcode.bak";
  // 清掉历史方案遗留的外部注入脚本 + 运行时配置，再还原 bundle
  try {
    fs.unlinkSync(path.join(path.dirname(bundle), "fitcode.inject.js"));
  } catch (e) {
    /* ignore */
  }
  try {
    fs.unlinkSync(path.join(path.dirname(bundle), LEGACY_INJECT_FILE));
  } catch (e) {
    /* ignore */
  }
  try {
    fs.unlinkSync(path.join(path.dirname(bundle), LEGACY_CONFIG_FILE));
  } catch (e) {
    /* ignore */
  }
  try {
    fs.unlinkSync(path.join(path.dirname(bundle), RUNTIME_CONFIG_FILE));
  } catch (e) {
    /* ignore */
  }
  if (fs.existsSync(bak)) {
    await fs.promises.copyFile(bak, bundle);
    await fs.promises.unlink(bak);
    return true;
  }
  return false;
}

// 把 fitcode.* 设置落成渲染层可读的 json（仅当 bundle 已打补丁时才写）
function runtimeConfig() {
  const c = vscode.workspace.getConfiguration("fitcode");
  const num = (k, d, lo, hi) => {
    const v = c.get(k);
    const n = typeof v === "number" && isFinite(v) ? v : d;
    return Math.min(hi, Math.max(lo, n));
  };
  const bool = (k, d) => {
    const v = c.get(k);
    return typeof v === "boolean" ? v : d;
  };
  return {
    center: bool("center", true),
    minTextWidth: num("minTextWidth", 640, 0, 4000),
    paddingRight: num("paddingRight", 20, 0, 400),
    animate: bool("animate", true),
    animateDuration: num("animateDuration", 140, 0, 1000),
    lineNumbersOnlyAtCursor: bool("lineNumbersOnlyAtCursor", true),
    cacheSize: num("cacheSize", 300, 10, 5000),
  };
}

async function writeRuntimeConfig(htmlPath) {
  // 在 VSCode 之外跑命令（test/apply.cjs 会设 FITCODE_APP_ROOT）时不写运行时配置：
  // 那种环境读不到 profile 里的设置，写进去只会把用户当前的配置覆盖成默认值。
  if (!htmlPath || process.env.FITCODE_APP_ROOT) return false;
  const bundle = bundlePathFor(htmlPath);
  try {
    if (!fs.existsSync(bundle)) return false;
    const src = await fs.promises.readFile(bundle, "utf8");
    if (!src.includes(BUNDLE_MARKER)) return false; // 没打补丁就不留文件
    await fs.promises.writeFile(
      path.join(path.dirname(bundle), RUNTIME_CONFIG_FILE),
      JSON.stringify(runtimeConfig()),
      "utf8",
    );
    try {
      fs.unlinkSync(path.join(path.dirname(bundle), LEGACY_CONFIG_FILE));
    } catch (e) {
      /* ignore */
    }
    return true;
  } catch (e) {
    return false;
  }
}

function isBundlePatched(htmlPath) {
  try {
    const bundle = bundlePathFor(htmlPath);
    if (!fs.existsSync(bundle)) return false;
    return fs.readFileSync(bundle, "utf8").includes(BUNDLE_MARKER);
  } catch (e) {
    return false;
  }
}

// VSCode 更新会整包替换安装目录，补丁（和备份）一起没。启动时发现"装过但现在没补丁"
// 就提醒一次，并给一个直接重新启用的按钮。
async function checkPatchAlive() {
  const htmlPath = locateWorkbenchHtml();
  if (!htmlPath) return;
  let wanted = false;
  try {
    wanted =
      vscode.workspace.getConfiguration("fitcode").get("enabled") === true;
  } catch (e) {
    return;
  }
  if (!wanted || isBundlePatched(htmlPath)) return;
  // 按钮文案先存成变量：VSCode 回传的就是这里给的字符串，拿中文字面量比较会永远不相等
  const reEnable = t("Re-enable");
  const pick = await vscode.window.showWarningMessage(
    t(
      "The FitCode patch is gone (a VS Code update replaces the install folder). Please enable it once more.",
    ),
    reEnable,
    t("Not now"),
  );
  if (pick === reEnable) {
    try {
      await vscode.commands.executeCommand("fitcode.enable");
    } catch (e) {
      /* ignore */
    }
  }
}

async function cmdEnable() {
  const htmlPath = locateWorkbenchHtml();
  if (!htmlPath) {
    vscode.window.showErrorMessage(t("FitCode: cannot find workbench.html"));
    return;
  }
  let html = await fs.promises.readFile(htmlPath, "utf8");
  const bak = backupPathFor(htmlPath);
  migrateLegacyBackup(bak); // 旧名字（Center Editor 时代）的 html 备份先改名过来
  const cspInFile = html.match(CSP_META);
  const recoveredCsp = cspInFile ? cspInFile[0] : recoverCsp(htmlPath);

  // 干净状态下先留一份完整原文，禁用时原样还原
  if (!fs.existsSync(bak)) {
    if (cspInFile) {
      await fs.promises.writeFile(bak, html, "utf8");
    } else if (recoveredCsp) {
      let clean = stripPatch(html)
        .replace(OTHER_BLOCK, "")
        .replace(OTHER_SESSION, "");
      clean = clean.replace("</head>", recoveredCsp + "\n</head>");
      await fs.promises.writeFile(bak, clean, "utf8");
    }
  }

  html = stripPatch(html);
  let removedOther = false;
  if (OTHER_BLOCK.test(html)) {
    removedOther = true;
    html = html.replace(OTHER_BLOCK, "").replace(OTHER_SESSION, "");
  }

  // 内联 <script> 必须去掉 CSP。⚠️ 顺序：先 stripPatch（它会把注释里的 meta 还原回正文），
  // 再取 CSP、再用全局正则把正文里所有 meta 删干净——否则残留的 meta 会静默拦掉注入脚本。
  const cspAfter = html.match(CSP_META);
  const csp = cspAfter ? cspAfter[0] : recoveredCsp;
  html = html.replace(new RegExp(CSP_META.source, "g"), "");
  const savedCsp = csp
    ? `<!-- !! FITCODE-CSP ${Buffer.from(csp, "utf8").toString("base64")} !! -->\n`
    : "";

  const block = `${savedCsp}${START}\n<script>${asset("inject.js")}</script>\n${END}\n</head>`;
  html = html.replace("</head>", block);

  const bp = await patchBundle(htmlPath);
  if (!bp.ok) {
    vscode.window.showErrorMessage("FitCode: " + bp.error);
    return;
  }
  try {
    await fs.promises.writeFile(htmlPath, html, "utf8");
  } catch (e) {
    vscode.window.showErrorMessage(
      t("FitCode: write failed (permission denied?). {0}", e.message),
    );
    return;
  }
  await writeRuntimeConfig(htmlPath);
  try {
    await vscode.workspace
      .getConfiguration("fitcode")
      .update("enabled", true, vscode.ConfigurationTarget.Global);
  } catch (e) {
    /* ignore */
  }
  // 整句各翻译一份，避免拼出「中文 + 半个英文括号」这种讲不通的句子
  const reload = t("Reload Window");
  const msg = removedOther
    ? t(
        "FitCode is applied and the previous Custom CSS injection was removed. Reload the window to take effect.",
      )
    : t("FitCode is applied. Reload the window to take effect.");
  const pick = await vscode.window.showInformationMessage(msg, reload);
  if (pick === reload)
    vscode.commands.executeCommand("workbench.action.reloadWindow");
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
    const html = await fs.promises.readFile(htmlPath, "utf8");
    if (html.includes(START))
      await fs.promises.writeFile(htmlPath, stripPatch(html), "utf8");
  }
  await unpatchBundle(htmlPath);
  try {
    await vscode.workspace
      .getConfiguration("fitcode")
      .update("enabled", false, vscode.ConfigurationTarget.Global);
  } catch (e) {
    /* ignore */
  }
  const reload = t("Reload Window");
  const pick = await vscode.window.showInformationMessage(
    t("FitCode has been restored. Reload the window."),
    reload,
  );
  if (pick === reload)
    vscode.commands.executeCommand("workbench.action.reloadWindow");
}

async function cmdStatus() {
  const htmlPath = locateWorkbenchHtml();
  const html = htmlPath ? await fs.promises.readFile(htmlPath, "utf8") : "";
  const cols = vscode.window.activeTextEditor
    ? columnsOfEditor(vscode.window.activeTextEditor)
    : 0;
  const bundle = htmlPath ? bundlePathFor(htmlPath) : "";
  const bundleSrc =
    bundle && fs.existsSync(bundle) ? fs.readFileSync(bundle, "utf8") : "";
  const yesNo = (b) => (b ? t("Yes") : t("No"));
  const runtimeCfg = (() => {
    try {
      const f = path.join(path.dirname(bundle), RUNTIME_CONFIG_FILE);
      return fs.existsSync(f)
        ? fs.readFileSync(f, "utf8")
        : t("missing (run Enable once)");
    } catch (e) {
      return t("read failed");
    }
  })();
  const lines = [
    t("Bundle patched: {0}", yesNo(bundleSrc.includes(BUNDLE_MARKER))),
    t(
      "Scrollbar and minimap pinned right: {0}",
      yesNo(bundleSrc.includes(BUNDLE_MARKER4)),
    ),
    t("Inline injection block in html: {0}", yesNo(html.includes(START))),
    t(
      "Leftover CSP meta in html: {0}",
      (html.match(new RegExp(CSP_META.source, "g")) || []).length,
    ),
    t(
      "Bundle backup: {0}",
      yesNo(bundle && fs.existsSync(bundle + ".fitcode.bak")),
    ),
    t("Runtime config: {0}", runtimeCfg),
    t("Longest line in current file: {0} cols", cols || "-"),
    t("workbench.html: {0}", htmlPath || t("not found")),
  ];
  vscode.window.showInformationMessage("FitCode — " + lines.join("\n"), {
    modal: true,
  });
}

/* ------------------------------------------------------------------ */
function activate(context) {
  // 仅开发隔离实例使用：常驻监视 /tmp/ce-work/AUTO_SPLIT 标记，组数<2 时自动分屏（E2E 用）
  try {
    const fsp = require("fs");
    setInterval(() => {
      try {
        if (!fsp.existsSync("/tmp/ce-work/AUTO_SPLIT")) return;
        if (vscode.window.tabGroups.all.length >= 2) {
          fsp.rmSync("/tmp/ce-work/AUTO_SPLIT");
          return;
        }
        vscode.commands
          .executeCommand("workbench.action.splitEditor")
          .catch(() => {});
      } catch {}
    }, 2000);
  } catch {}

  // 启动时同步一次运行时配置；之后设置一变就重写（渲染层轮询拿到即生效，不需要重载）
  try {
    const hp = locateWorkbenchHtml();
    if (hp) writeRuntimeConfig(hp).catch(() => {});
  } catch (e) {
    /* ignore */
  }
  try {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("fitcode")) return;
        try {
          const hp = locateWorkbenchHtml();
          if (hp) writeRuntimeConfig(hp).catch(() => {});
        } catch (err) {
          /* ignore */
        }
      }),
    );
  } catch (e) {
    /* ignore */
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("fitcode.enable", cmdEnable),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("fitcode.disable", cmdDisable),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("fitcode.status", cmdStatus),
  );

  // 启动后稍等一下再查（避开启动期的通知高峰）
  setTimeout(() => {
    checkPatchAlive().catch(() => {});
  }, 2500);
}

function deactivate() {}

exports.activate = activate;
exports.deactivate = deactivate;
