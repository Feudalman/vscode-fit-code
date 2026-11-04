# Center Editor

让 VSCode 的编辑器像 JetBrains 那样：**正文宽度自适应内容**——内容窄时编辑区居中，内容超出面板时自动撑满并横向滚动。行号跟随正文一起缩进，tab 栏永远满宽。

纯自适应，无阈值配置：任何文件，只要内容放得下就居中，放不下自动撑满。

## 这是什么

一个 VSCode 扩展，通过（可选启用的）补丁修改 VSCode 自身的布局计算：

- **渲染层**（`media/inject.js`）：对每个编辑器，读取自己的文档全文，计算最长行的视觉宽度（Tab 展开、全角字符计 2、去尾随空白），按"自己的面板宽 − 行号列 − minimap − 滚动条 − 目标宽"算出居中内缩量，写入自己的 `rulers` 选项（透明标尺，不可见）作为载体。
- **布局层**（bundle 补丁）：Monaco 的 `computeLayout` 读取每个编辑器自己的 rulers 载体，把内缩量应用到 glyphMargin/行号/装饰/contentLeft（+pad）、contentWidth（−2×pad）、minimapLeft（−pad）。

**分屏时每个编辑器组按自己的宽度和内容独立计算**，互不干扰（rulers 是每编辑器独立的真实 option，天然无冲突）。

## 安装与使用

本扩展通过修改 VSCode 安装目录内的两个文件工作（自动备份、可一键还原）：

1. 将本目录拷贝到 `~/.vscode/extensions/local.center-editor-0.1.0/`
2. 重载窗口后，命令面板执行 **`Center Editor: 启用`** → 按提示重载窗口
3. 完成——打开窄文件会居中，宽文件自动撑满

**停用**：命令面板执行 **`Center Editor: 禁用`** → 重载窗口（从自动备份原样还原）。
**状态**：命令面板执行 **`Center Editor: 状态`**。

## 已知边界

- `editor.wordWrap` 开启的文件不居中（自动换行模式下无意义）
- 编辑器面板宽度 < 400px 时不居中
- VSCode 升级后补丁锚点可能失配——扩展会检测并拒绝打补丁（不会损坏安装），需等适配新版本
- 首次启用后 VSCode 可能提示"安装似乎损坏"——哈希校验的预期反应，点关闭即可

## 开发

- `src/extension.js`：扩展主逻辑——workbench.html/bundle 的补丁、还原、启用/禁用命令
- `media/inject.js`：注入到渲染层的自适应脚本（列数计算 + rulers 载体写入）
- E2E 测试脚本与干净 bundle 留档见仓库外 `/tmp/ce-work/`（未入库）

### 补丁原理（`src/extension.js` 的 `patchBundle`）

对 `workbench.desktop.main.js` 打三处补丁（各带唯一性断言，失配即放弃）：

1. `_createConfiguration`：把每个 CodeEditor 实例暴露到 `window.__ceEditors`
2. `updateOptions`：兜底注册（配置变化等路径）
3. `computeLayout` 头部：门控（wordWrap=off 且宽度≥400）+ 从 rulers 读取内缩量 `__ceP`；返回值里 glyphMargin/行号/装饰/contentLeft += `__ceP`、contentWidth −= 2×`__ceP`、minimapLeft −= `__ceP`

每次打补丁前自动备份原文件为 `*.center-editor.bak`，禁用时原样还原。
