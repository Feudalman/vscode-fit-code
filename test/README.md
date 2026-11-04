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
（也可以用打补丁前的 `.center-editor.bak`）：

```bash
cp "/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js" /tmp/fitcode/clean.mjs
node --check /tmp/fitcode/clean.mjs
```

### 3. 生成补丁后的 bundle（E2E 的注入体）

```bash
node test/patch-bundle.js /tmp/fitcode/clean.mjs /tmp/fitcode/patched-body.js
node --check /tmp/fitcode/patched-body.js
```

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

## 运行

```bash
node test/e2e-v5.mjs        # 完整 E2E：注入补丁体 + inject + 断言 8 项
node test/measure.mjs 9337  # 现场诊断：量任意带调试口实例的各层几何
```

## 断言内容

| 场景 | 预期 |
|---|---|
| 短文件（10 列，面板 1023） | 居中，内缩 ≈124px（minWidth 640 抬升目标宽） |
| 中文件（99 列，792px） | 放得下 → 居中，小幅内缩 |
| 长文件（1886 列） | 不放 → 撑满 + 横向滚动（contentLeft = 原生 gutter） |
| 分屏 | 每组按自己的宽度与内容**独立**计算，互不影响 |

## 踩过的坑（勿重复）

1. **替换文本结尾多逗号**：锚点不含逗号时替换不能加（产出 `|0,,` 语法错误）——`node --check` 每次必跑
2. **`|| 默认值` 吞 0**：合法的 0（永不居中）被 `|| 700` 回退——改用显式判空
3. **锚点歧义**：`glyphMarginLeft:...,minimap:(\w+)` 会匹配 bundle 里其他相似对象（diff 布局等）——
   锚点必须带 `\\{width:(\\w+),height:(\\w+),` 前缀消除歧义，且替换文本要重新输出 width/height 字段
4. **状态栏信道不可靠**：扩展宿主的状态栏项在部分环境同步不到渲染器——已废除，列数计算移入渲染层
5. **VSCode 不吃 `--window-size`**：窗口尺寸靠预置 profile 的 `storage.json` 的 `windowsState`
6. **合成键盘事件不触发 VSCode 命令**：需要执行 workbench 命令时走扩展 API（如 AUTO_SPLIT 监视器），鼠标事件可用
