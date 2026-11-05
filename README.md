# Center Editor

让 VSCode 的编辑器像 JetBrains 那样：**正文宽度自适应内容**——内容窄时编辑区居中，内容超出面板时自动撑满并横向滚动。行号跟随正文一起缩进，tab 栏永远满宽，**滚动条与 minimap 始终钉在编辑器右边缘**。

纯自适应，无阈值配置：任何文件，只要内容放得下就居中，放不下自动撑满。

## 这是什么

一个 VSCode 扩展，通过（可选启用的）补丁修改 VSCode 自身的布局计算：

- **渲染层**（`media/inject.js`）：对每个编辑器，读取自己的文档全文，计算最长行的视觉宽度（Tab 展开、全角字符计 2、去尾随空白），按"自己的面板宽 − 行号列 − minimap − 滚动条 − 目标宽"算出居中内缩量，写入自己的 `rulers` 选项（透明标尺，不可见）作为载体。
- **布局层**（bundle 补丁）：Monaco 的 `computeLayout` 读取每个编辑器自己的 rulers 载体，把内缩量应用到 glyphMargin/行号/装饰/contentLeft（+pad）、contentWidth（−2×pad）；`EditorScrollbar._setLayout` 再把承载正文的容器**加宽 pad**（不动 left），使容器右缘铺回编辑器最右。
- **注入方式**：`media/inject.js` 内联写进 `workbench.html`。内联脚本要求移除 `workbench.html` 的 CSP meta——原文以 base64 注释留在文件里，禁用时原样还原。

**切文件不闪**：渲染层是事件驱动的（`onDidChangeModel` / 内容变化 / 布局变化），切 tab 时在绘制前就把 rulers 写对；
最长行结果按文件 uri 缓存在 `localStorage`（行数 + 字符总数 + 首尾行采样做指纹），重开同一文件直接复用。
宽度变化默认带 140ms CSS 过渡（`media/inject.js` 顶部的 `ANIMATE` / `ANIM_MS`），只作用于 `.editor-scrollable` 的 left/width，不影响鼠标命中。

**只有正文/行号居中**：minimap 与滚动条保持贴右边缘（滚动条是正文容器的子元素，靠"容器只加宽不左移"实现）。

**分屏时每个编辑器组按自己的宽度和内容独立计算**，互不干扰（rulers 是每编辑器独立的真实 option，天然无冲突）。

## 安装与使用

本扩展修改 VSCode 安装目录内的两个文件（都自动备份、可一键还原）：

- `workbench.desktop.main.js`：4 处锚点补丁
- `workbench.html`：插入内联注入脚本（并把 CSP meta 挪进 base64 注释）

1. 将本目录拷贝到 `~/.vscode/extensions/local.center-editor-<package.json 里的 version>/`
2. 重载窗口后，命令面板执行 **`Center Editor: 启用`** → 按提示重载窗口
3. 完成——打开窄文件会居中，宽文件自动撑满

**停用**：命令面板执行 **`Center Editor: 禁用`** → 重载窗口（从自动备份原样还原）。
**状态**：命令面板执行 **`Center Editor: 状态`**。
**升级**：换上新版扩展目录后，直接执行一次 **`Center Editor: 启用`** 即可——检测到旧版补丁会先从备份还原，再按新版重打全部补丁。

## 已知边界

- `editor.wordWrap` 开启的文件不居中（自动换行模式下无意义）
- 编辑器面板宽度 < 400px 时不居中（窗口被缩成小方块时看起来就是"完全没生效"）
- VSCode 升级后补丁锚点可能失配——扩展会检测并拒绝打补丁（不会损坏安装），需等适配新版本
- 首次启用后 VSCode 可能提示"安装似乎损坏"——哈希校验的预期反应，点关闭即可

## 开发

- `src/extension.js`：扩展主逻辑——workbench.html/bundle 的补丁、还原、启用/禁用命令
- `media/inject.js`：注入到渲染层的自适应脚本（列数计算 + rulers 载体写入）
- `test/`：CDP 驱动的 E2E（`e2e.mjs`）、离线补丁体生成（`patch-bundle.js`）、现场几何诊断（`measure.mjs`），用法与断言表见 `test/README.md`

### 补丁原理（`src/extension.js` 的 `patchBundle`）

对 `workbench.desktop.main.js` 打四处补丁（各带唯一性断言，失配即放弃）：

1. `_createConfiguration`：把每个 CodeEditor 实例暴露到 `window.__ceEditors`
2. `updateOptions`：兜底注册（配置变化等路径）
3. `computeLayout` 头部：门控（wordWrap=off 且宽度≥400）+ 从 rulers 读取内缩量 `__ceP`；返回值里 glyphMargin/行号/装饰/contentLeft += `__ceP`、contentWidth −= 2×`__ceP`
4. `EditorScrollbar._setLayout`：滚动条容器**左边不动**（`left = contentLeft`，正文位置就是这个容器的 left，动它会连正文一起挪走）、**宽度加 pad**（`width = contentWidth + pad (+minimapWidth)`），让容器右缘铺到编辑器最右，里面的竖滚动条 / overview ruler 自然贴右

> 为什么需要第 4 处：滚动条是 `contentLeft+contentWidth` 那个容器的子元素，第 3 处补丁把 `contentWidth` 缩小了 `2×pad`，滚动条于是"跟着正文居中"。第 4 处只把容器加宽 `pad`，正文位置不变。

每次打补丁前自动备份原文件为 `workbench.desktop.main.js.center-editor.bak`，禁用时原样还原。
升级安装：换上新版扩展目录后执行一次 `Center Editor: 启用` 即可——检测到旧版补丁痕迹会先从备份还原再按新版重打（备份丢了会明确报错，不会损坏安装）。
