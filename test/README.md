# 测试（E2E）

## 概览

E2E 采用 **CDP（Chrome DevTools Protocol）驱动**的方式：

1. 以隔离 profile 启动 VSCode（带 `--remote-debugging-port`）
2. 通过 CDP 的 `Fetch.requestPaused` 拦截 `workbench.desktop.main.js` 的响应，
   替换为补丁后的版本（**不触碰磁盘上的 VSCode 安装**）
3. 通过 `Page.addScriptToEvaluateOnNewDocument` 注入 `media/inject.js`
4. 重载页面后断言各场景的几何数据（contentLeft / 行号位置 / 分屏独立性）

## 前置准备

### 1. 测试文件

```bash
mkdir -p /tmp/fitcode
python3 - <<'EOF'
open('/tmp/fitcode/ce-short.txt','w').write('short line\n'*40)          # 10 列
with open('/tmp/fitcode/ce-mid.txt','w') as f:                          # 99 列
    for i in range(40): f.write(f'line {i}: ' + 'x'*90 + '\n')
with open('/tmp/fitcode/ce-long.txt','w') as f:                         # 1886 列
    for i in range(220): f.write(f'line {i}: ' + 'y'*1200 + '\n')
EOF
```

### 2. 干净的 bundle 基线（clean.mjs）

从**未打补丁**的 VSCode 安装复制一份 `workbench.desktop.main.js` 作为补丁基线
（也可以用打补丁前的 `.fitcode.bak`）：

```bash
cp "/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js" /tmp/fitcode/clean.mjs
node --check /tmp/fitcode/clean.mjs
```

### 3. 生成补丁后的 bundle（E2E 的注入体）

> 补丁 1~4 与扩展 `启用` 时打的完全一致；注入脚本仍由 E2E 单独注入（不走 html）。

```bash
node test/patch-bundle.js /tmp/fitcode/clean.mjs /tmp/fitcode/patched-body.js
node --check /tmp/fitcode/patched-body.js
```

> 输入必须是**未打补丁**的干净 bundle（补丁 3/4 的锚点在已补丁体上已失配，会直接报错退出）。

### 4. 启动隔离实例

```bash
rm -rf /tmp/fitcode/profile && mkdir -p /tmp/fitcode/profile/extensions /tmp/fitcode/profile/User/globalStorage
# 预置窗口尺寸（分屏测试需要宽窗口）
python3 -c "
import json
d = {'windowsState': {'lastActiveWindow': {'uiState': {'mode': 1, 'x': 0, 'y': 25, 'width': 2400, 'height': 1375}}, 'openedWindows': []}}
json.dump(d, open('/tmp/fitcode/profile/User/globalStorage/storage.json', 'w'))
"
# 分屏测试标记：扩展激活后若组数<2 会自动 splitEditor（仅开发版扩展有此逻辑）
touch /tmp/fitcode/AUTO_SPLIT

"/Applications/Visual Studio Code.app/Contents/MacOS/Code" \
  --remote-debugging-port=9337 \
  --user-data-dir=/tmp/fitcode/profile \
  --extensions-dir=/tmp/fitcode/profile/extensions \
  --extensionDevelopmentPath=<本仓库路径> \
  --disable-workbench-trust \
  --new-window /tmp/fitcode/ce-short.txt /tmp/fitcode/ce-mid.txt /tmp/fitcode/ce-long.txt &
```

## 不开 GUI 应用改动

```bash
node test/apply.cjs install    # 同步仓库代码到 ~/.vscode/extensions/local.fitcode-<version>/
node test/apply.cjs status     # 安装态 + 运行时配置
node test/apply.cjs enable     # 打补丁（bundle / workbench.html）
node test/apply.cjs disable    # 从备份还原
```

`apply.cjs` 用 `Module._load` 把 `vscode` 模块 stub 掉，命令字段和真实扩展一致；它不改 `fitcode.config.json`（在 VSCode 之外读不到 profile 设置，写了只会覆盖用户配置）。

## 运行

```bash
node test/e2e.mjs        # 完整 E2E：注入补丁体 + inject + 断言 12 项（需先按上文起实例）
node test/measure.mjs 9337  # 现场诊断：量任意带调试口实例的各层几何
```

## 断言内容

内缩量定义为 `padL = contentLeft − gutter`（原生 gutter = glyphMargin+lineNumbers+decorations），
`padR = (width − minimapWidth) − (contentLeft + contentWidth)`；**居中 ⇔ padL == padR**（与面板宽无关，不写死像素）。

| 场景 | 预期 |
|---|---|
| 短文件（10 列） | 居中：padL == padR > 0；**滚动条右缘距面板右缘 = 0** |
| 中文件（99 列，放得下） | 居中：padL == padR > 0；滚动条仍钉右缘 |
| 长文件（1886 列） | 放不下 → 撑满：padL == padR == 0；滚动条仍钉右缘 |
| 分屏左组（长） | 撑满（padL == 0） |
| 分屏右组（短） | 居中，且与左组内缩量不同（各组独立计算） |
| 分屏两组 | 各自滚动条钉在自家右缘；minimap 右缘 = `width − verticalScrollbarWidth`（不跟内容左移） |

> 滚动条断言是关键回归项：只做 patch3（不钉右）时 `scrollbarRightGap` 会等于内缩量（实测 636/555px），看起来就是"滚动条跟着正文居中"。

## 踩过的坑（勿重复）

1. **替换文本结尾多逗号**：锚点不含逗号时替换不能加（产出 `|0,,` 语法错误）——`node --check` 每次必跑
2. **`|| 默认值` 吞 0**：合法的 0（永不居中）被 `|| 700` 回退——改用显式判空
3. **锚点歧义**：`glyphMarginLeft:...,minimap:(\w+)` 会匹配 bundle 里其他相似对象（diff 布局等）——
   锚点必须带 `\\{width:(\\w+),height:(\\w+),` 前缀消除歧义，且替换文本要重新输出 width/height 字段
4. **状态栏信道不可靠**：扩展宿主的状态栏项在部分环境同步不到渲染器——已废除，列数计算移入渲染层
5. **VSCode 不吃 `--window-size`**：窗口尺寸靠预置 profile 的 `storage.json` 的 `windowsState`
6. **合成键盘事件不触发 VSCode 命令**：需要执行 workbench 命令时走扩展 API（如 AUTO_SPLIT 监视器），鼠标事件可用
7. **滚动条位置不在 `computeLayout` 里**：竖滚动条是 `right:0` 贴在 `EditorScrollbar` 容器上的，容器的 `left/width` 由 `_setLayout` 从 layoutInfo 取——`contentLeft/contentWidth` 一内缩，右边就会跟着缩（表现为滚动条居中）
8. **`contentWidth` 语义含 vsb**：原生 `contentWidth = width − gutter − minimapWidth`，正文区右边界是 `width − minimapWidth`，不是 `width − verticalScrollbarWidth`；拿右边减去 vsb 算对称会恒定偏 14px，断言全至
9. **`Set.forEach` 第二参是值不是下标**：`window.__ftEditors` 是 Set，`forEach((ed,i)=>…)` 里的 `i` 其实是 editor 对象；把它回传给 CDP 会报 `Object reference chain is too long`
10. **AUTO_SPLIT 标记会被扩展消费后删除**：分屏等待循环里要每轮重写标记（`Page.reload` 后分屏可能回到 1 组）
11. **正文和滚动条住在同一个容器里**：`EditorScrollbar._setLayout` 里的 `scrollbarDomNode` 就是 `.monaco-scrollable-element.editor-scrollable`——`lines-content`（正文）、`decorationsOverviewRuler`、竖滚动条都是它的子元素，**正文位置 = 该容器的 left**。所以只能"宽度加 pad"让右缘铺到最右，**绝不能改 left**（改了正文会一起左移，表现为"完全不居中"）。
12. **E2E 覆盖不到注入链路**：E2E 用 `Page.addScriptToEvaluateOnNewDocument` 注入 inject.js、用 CDP 替换 bundle，全程不读磁盘上的 `workbench.html`。所以"CSP 拦掉内联脚本"这类问题 E2E 永远绿。真机自查：`window.__ftLoaded === true` 且 `document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length === 0`。
13. **`stripPatch` 会把 CSP 从注释还原回正文**：`cmdEnable` 若在 `stripPatch` 之前取 `cspInFile`，还原出来的 meta 就永远删不掉 → CSP 静默拦掉内联注入脚本（无报错、无日志）。正确顺序：先 `stripPatch`，再取 CSP，再用全局正则删掉所有 meta，最后写 `CSP 注释 + 注入块`。
14. **别动态建 `<script>` 来加载注入脚本**：CSP 带 `require-trusted-types-for 'script'`，`script.src = 字符串` 会报 `This document requires 'TrustedScriptURL' assignment`，且 `trusted-types` 白名单里没有我们。注入老老实实内联进 html。
15. **先看窗口尺寸再怀疑补丁**：补丁门控要求编辑器面板 ≥ 400px。窗口被缩成 143×145 这种小方块时，看 DOM 一切正常、layoutInfo 里 pad 也在，但屏幕上看就是"完全没生效"。排查前先 `Quartz.CGWindowListCopyWindowInfo` 或 System Events 确认窗口尺寸。
16. **CDP 量到的窗口 ≠ 你眼前的窗口**：多窗口/多屏时 `json/list` 里的 target 可能是隐藏窗口。真要判断"用户看到的效果"，用同一个 target 的 `Page.captureScreenshot`，或者直接量 `.view-lines` / `.editor-scrollable` 的 `getBoundingClientRect()`。
17. **设置通道不经过 E2E**：渲染层靠轮询 `out/vs/workbench/fitcode.config.json` 拿配置（扩展在启用/设置变化时写）。E2E 直接用 CDP 注入脚本，量的是几何，不会验证这个文件通道。改配置相关逻辑后要手动验：改一项设置 → 2 秒内看到效果。
