# AGENTS.md

## 项目

VSCode 扩展 FitCode：让编辑器正文按内容宽度居中，滚动条与 minimap 留在编辑器最右。
它通过修改 VSCode 安装目录实现（`workbench.desktop.main.js` 打补丁 + `workbench.html` 内联注入脚本），
所以**任何改动都可能让用户的编辑器打不开**，先读 `README.zh-CN.md` 的「补丁原理」和 `test/README.md` 的「踩过的坑」。

## 目录

- `src/extension.js`：启用/禁用/状态命令；`patchBundle` 打 4 处补丁
- `media/inject.js`：渲染层脚本，算每个编辑器的最长行宽度并把内缩量写进 `rulers`；自动换行时改用
  `minTextWidth` 当阅读欄宽（每行都能折，没有“自然宽度”可言）
- `test/patch-bundle.js`：离线生成补丁体（E2E 用），**必须与 `patchBundle` 保持同一套补丁**
- `test/e2e.mjs` / `test/measure.mjs`：CDP 驱动的几何断言 / 现场诊断
- `test/README.md`：E2E 用法、断言表、踩坑清单
- `docs/`：官网（`index.html` + `site.css` + `site.js`，GitHub Pages 发这个目录）＋ README 用的图。纯静态，无构建、无依赖
- `package.json` / `icon.png` / `LICENSE` / `CHANGELOG.md` / `.vscodeignore`：上架市场用，改版本号要同步 `CHANGELOG.md` 与 `docs/index.html` 顶部的 `v0.x.y`

## 命令

```bash
node --check src/extension.js media/inject.js test/*.mjs   # 改完必跑
node test/patch-bundle.js <干净bundle> <输出bundle>        # 生成补丁体并 --check
```

E2E 需要先起隔离实例，步骤见 `test/README.md`。没有实例时，至少跑离线 `启用 → 禁用` 回归。

## 如何应用与验证

改完代码后照这个顺序走，别让用户手动点命令面板：

```bash
node test/apply.cjs install     # 同步仓库代码到 ~/.vscode/extensions/arui.fitcode-<version>/（开发副本）
node test/apply.cjs enable      # 对真实安装打补丁（bundle + workbench.html）
node test/apply.cjs status      # 查安装态 + 运行时配置
```

- **日常用的那份来自扩展市场**（`arui.fitcode`）；`apply.cjs install` 建的是一份开发副本，两者会同时激活、各打一遍补丁。改完代码要真机验证时，先 `code --uninstall-extension arui.fitcode` 卸市场版，验完再删副本装回市场版
- `apply.cjs` 把 `vscode` 模块 stub 掉，直接调 `fitcode.enable/disable/status`；stub 读不到 profile 设置，`activate()` 会把 `fitcode.config.json` 写成默认值——跑完记得按用户 `settings.json` 改回去
- 干净 bundle 的来源：安装目录里的 `<bundle>.fitcode.bak`（禁用后天然是干净体），或从 `VSCode.app/Contents/Resources/app/out/vs/workbench/` 直接复制
- 应用/还原后必须让 VSCode **重载窗口**（`open -a` 重启也算）才生效
- 判断"看起来对不对"必须看真机：先把窗口拉到 ≥800px（面板 <400px 按设计不居中），必要时 `screencapture -R` 抓窗口区域；单独起 `Code --user-data-dir=/tmp/xxx --remote-debugging-port=…` 的隔离实例可以只做几何测量
- VSCode 自身更新会替换整个 app 目录（bundle、html、备份全没）。扩展启动 2.5s 后会检查「设置里 enabled=true 但 bundle 没补丁」并弹通知（`checkPatchAlive`），这条路径只能改代码验逻辑，实际弹窗要在真机看
- 排查顺序见下节

## 发布

市场上的 id 是 `arui.fitcode`（`publisher` 必须是 `arui`，不是 `local`）。

```bash
vsce package                                 # 先打包看清单：不该有 test/、docs/、AGENTS.md
code --install-extension fitcode-<version>.vsix --force   # 装一遍确认能启用
vsce publish                                 # PAT 在登录钥匙串里，vsce login 不用重跑
```

- `repository` 字段不能删：vsce 靠它把 README 里的相对图片改写成 `raw/HEAD/...` 绝对地址，
  所以 `docs/` 可以从包里整个排除，图片照样能显示
- README 里不能出现 SVG（市场直接拒收），示意图要用 PNG（`docs/layout.png` 由 `docs/layout.svg` 渲染）
- 发新版本：改 `package.json` 的 `version` + `CHANGELOG.md` + `docs/index.html` 顶部的 `vx.y.z`，再 `vsce publish`

## 硬约束

1. `patchBundle` 与 `test/patch-bundle.js` 是同一套补丁的两份实现，改一处必须同步另一处。
2. 第 4 处补丁（`EditorScrollbar._setLayout`）里那个容器**就是正文容器**：`left` 绝不能改，只能把 `width` 加 pad。
3. 第 3 处补丁的返回值里**不要动 `minimapLeft`**，minimap 要留在原生位置。
4. `cmdEnable` 的顺序固定：先 `stripPatch` → 再取 CSP → 用全局正则删掉**所有** CSP meta → 最后写 `CSP 注释 + 注入块`。
5. 不要用外部 `<script>` 加载注入脚本（CSP 的 `require-trusted-types-for 'script'` 会拦），注入只走 html 内联。
6. 补丁锚点必须带唯一性断言，失配就放弃打补丁，绝不"猜着改"。
7. 行号显隐只改 `opacity`（保留行号列宽度），不要动 `lineNumbersWidth` / gutter——否则正文位置会跟着光标跳。
8. 渲染层读不到 VSCode 设置：新增开关要同时改五处——`package.json` 的 `contributes.configuration`
   （`description` 写成 `%fitcode.config.<名字>.description%`）、`package.nls.json` 和
   `package.nls.zh-cn.json` 各补一条说明、`src/extension.js` 的 `runtimeConfig()`、
   `media/inject.js` 的 `DEFAULTS` + `applyConfig()`。
9. 自动换行的支持**不能只改 `contentWidth`**：Monaco 的 `viewportColumn` / `wrappingColumn`
   在 `computeLayout` 里就已按原宽度算好，只缩 `contentWidth` 的话 pad 只挪位置、文字仍在原宽度上折行。
   补丁 3 必须用 `__ftVC(w)` 按收窄后的宽度重算这两个字段；`__ftP=0` 时返回原值，保证未内缩场景语义不变。

## 排查"改了没生效"

按顺序看，别跳：窗口/编辑器面板是否 ≥ 400px（< 400px 按设计不居中和）→ `window.__ftLoaded === true` →
`html` 里有没有残留 CSP meta → 编辑器 `getOption(117)` 的 rulers 是否有 pad →
`.monaco-scrollable-element.editor-scrollable` 的 `left` 与 `width`。
markdown 这类默认 `wordWrap=on` 的文件现在也会居中，但如果内容比 `minTextWidth` 宽还看不出变化，
先看 `getLayoutInfo()` 的 `wrappingColumn` 有没有跟着收窄（没缩就是补丁 3 的 `__ftVC` 没生效）。
注意：CDP 里量到的窗口可能不是用户眼前的窗口，判断"看起来对不对"要用同一个 target 的 `Page.captureScreenshot`。

## 提交规范

- PR / commit **标题必须全英文**。
- commit message 的描述部分不限语言与长度，写清动机和影响即可。
