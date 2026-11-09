// 离线生成打过补丁的 bundle（E2E 注入体 / 手工排障用）。
// 与 src/extension.js 的 patchBundle 保持同一套补丁：
//   补丁1  _createConfiguration：把每个 CodeEditor 实例放进 window.__ftEditors
//   补丁2  updateOptions：兜底注册 + window.__ftBundlePatched 标记
//   补丁3  computeLayout：门控(wordWrap≠wordWrapColumn 且宽度≥400) + 从 rulers(EditorOption 117) 读内缩量 __ftP，
//          返回值里 glyphMargin/行号/装饰/contentLeft += __ftP、contentWidth −= 2×__ftP，
//          并把 viewportColumn / wrappingColumn 按收窄后的宽度重算（自动换行时文字才会在窄栏里折行）；minimap 保持原生
//   补丁4  EditorScrollbar._setLayout：宿主容器 left 不动（正文位置 = 容器 left）、width += pad，
//          让竖/横滚动条与 overview ruler 贴回编辑器最右
// 用法: node test/patch-bundle.js <干净bundle路径> <输出路径>
const fs = require("fs");

const srcPath = process.argv[2],
  outPath = process.argv[3];
if (!srcPath || !outPath) {
  console.error("usage: node test/patch-bundle.js <src> <out>");
  process.exit(1);
}
let src = fs.readFileSync(srcPath, "utf8");
const reg = "(window.__ftEditors||(window.__ftEditors=new Set)).add(this)";

// ---- 补丁 1：暴露 editor 实例 ----
const a1 =
  /_createConfiguration\((\w+),(\w+),(\w+),(\w+)\)\{return new ([\w$]+)\(\1,\2,\3,this\._domElement,\4\)\}/;
{
  const n = src.match(new RegExp(a1.source, "g"));
  if (!n || n.length !== 1) {
    console.error("锚点1 匹配 " + (n ? n.length : 0) + " 处，放弃");
    process.exit(1);
  }
  src = src.replace(
    a1,
    "_createConfiguration($1,$2,$3,$4){var __ft=new $5($1,$2,$3,this._domElement,$4);" +
      reg +
      ";return __ft}",
  );
  if (!src.includes(";return __ft}")) {
    console.error("补丁1 自检失败：缺右花括号");
    process.exit(1);
  }
}

// ---- 补丁 2：updateOptions 兜底注册 + flag ----
const a2 =
  /updateOptions\((\w+)\)\{this\._configuration\.updateOptions\(\1\|\|\{\}\)\}/;
{
  const n = src.match(new RegExp(a2.source, "g"));
  if (n && n.length === 1) {
    src = src.replace(
      a2,
      "updateOptions($1){this._configuration.updateOptions($1||{});" +
        reg +
        "}",
    );
  }
  src = "window.__ftBundlePatched=1;" + src;
}

// ---- 补丁 3a：computeLayout 头部 —— 门控 + 从 rulers 选项读内缩量 ----
// ⚠️ 替换文本结尾不加逗号（锚点不含逗号，加了会产出 |0,, 语法错误，已踩过两次）
const a3h = /computeLayout\((\w+),(\w+)\)\{let (\w+)=\2\.outerWidth\|0/;
{
  const n = src.match(new RegExp(a3h.source, "g"));
  if (!n || n.length !== 1) {
    console.error("锚点3头 匹配 " + (n ? n.length : 0) + " 处，放弃");
    process.exit(1);
  }
  src = src.replace(
    a3h,
    "computeLayout($1,$2){" +
      'var __ftW=$1.get(156);__ftW=__ftW==="inherit"?$1.get(155):__ftW;' +
      '__ftW=__ftW==="inherit"?$1.get(151):__ftW;' +
      'var __ftGate=(__ftW!=="wordWrapColumn"&&$2.outerWidth>=400);' +
      "var __ftK=$1.get(117)||[];" +
      'var __ftP=(__ftGate&&__ftK.length&&typeof __ftK[0].column==="number")?__ftK[0].column:0;' +
      'var __ftCW=$2.typicalHalfwidthCharacterWidth||8;' +
      'var __ftVS=($1.get(118)||{}).verticalScrollbarSize||14;' +
      "var __ftVC=function(w){return Math.max(1,Math.floor((Math.max(1,w-2*__ftP)-__ftVS-2)/__ftCW))};" +
      "var __ftV163=$1.get(163),__ftF=$1.get(154)||0;" +
      "let $3=$2.outerWidth|0",
  );
}

// ---- 补丁 3b：返回值 —— 左链整体内缩 + contentWidth 收缩（minimap 保持原生）----
// ⚠️ 锚点带 {width:/height: 前缀时，替换文本必须重新输出它们（漏了会丢字段，已踩过一次）
const a3r =
  /\{width:(\w+),height:(\w+),glyphMarginLeft:(\w+),glyphMarginWidth:(\w+),glyphMarginDecorationLaneCount:([\w$.]+),lineNumbersLeft:(\w+),lineNumbersWidth:(\w+),decorationsLeft:(\w+),decorationsWidth:(\w+),contentLeft:(\w+),contentWidth:(\w+),minimap:(\w+),viewportColumn:(\w+),isWordWrapMinified:(\w+),isViewportWrapping:(\w+),wrappingColumn:(\w+)/;
{
  const n = src.match(new RegExp(a3r.source, "g"));
  if (!n || n.length !== 1) {
    console.error("锚点3返回 匹配 " + (n ? n.length : 0) + " 处，放弃");
    process.exit(1);
  }
  src = src.replace(
    a3r,
    "{width:$1,height:$2," +
      "glyphMarginLeft:$3+__ftP,glyphMarginWidth:$4,glyphMarginDecorationLaneCount:$5," +
      "lineNumbersLeft:$6+__ftP,lineNumbersWidth:$7,decorationsLeft:$8+__ftP,decorationsWidth:$9," +
      "contentLeft:$10+__ftP,contentWidth:Math.max(1,$11-2*__ftP),minimap:$12," +
      "viewportColumn:(__ftP>0?__ftVC($11):$13),isWordWrapMinified:$14,isViewportWrapping:$15," +
      "wrappingColumn:(__ftP>0&&$16>0?" +
      "function(){var c=Math.max(1,__ftVC($11)-(__ftV163?1:0));" +
      'return __ftW==="bounded"?Math.min(c,__ftF||c):c}():$16)',
  );
}

// ---- 补丁 4：EditorScrollbar._setLayout —— 正文容器只加宽，滚动条/overview ruler 贴右 ----
const a4 =
  /_setLayout\(\)\{let (\w+)=this\._context\.configuration\.options,(\w+)=\1\.get\(168\);this\.scrollbarDomNode\.setLeft\(\2\.contentLeft\),\1\.get\(81\)\.side==="right"\?this\.scrollbarDomNode\.setWidth\(\2\.contentWidth\+\2\.minimap\.minimapWidth\):this\.scrollbarDomNode\.setWidth\(\2\.contentWidth\),this\.scrollbarDomNode\.setHeight\(\2\.height\)\}/;
{
  const n = src.match(new RegExp(a4.source, "g"));
  if (!n || n.length !== 1) {
    console.error("锚点4 匹配 " + (n ? n.length : 0) + " 处，放弃");
    process.exit(1);
  }
  src = src.replace(
    a4,
    "_setLayout(){let $1=this._context.configuration.options,$2=$1.get(168);" +
      // 与补丁3 同一门控：wordWrap 除了“用户写死列宽”以外都认 rulers 里的内缩量
      'var __ftW=$1.get(156);__ftW=__ftW==="inherit"?$1.get(155):__ftW;' +
      '__ftW=__ftW==="inherit"?$1.get(151):__ftW;' +
      "var __ftK=$1.get(117)||[];" +
      'var __ftSb=(__ftW!=="wordWrapColumn"&&$2.width>=400&&__ftK.length&&typeof __ftK[0].column==="number")?__ftK[0].column:0;' +
      // 左边界不动：正文位置 = 容器 left，动它会连正文一起挪走
      "this.scrollbarDomNode.setLeft($2.contentLeft)," +
      '$1.get(81).side==="right"?this.scrollbarDomNode.setWidth($2.contentWidth+__ftSb+$2.minimap.minimapWidth)' +
      ":this.scrollbarDomNode.setWidth($2.contentWidth+__ftSb)," +
      "this.scrollbarDomNode.setHeight($2.height)}",
  );
}

fs.writeFileSync(outPath, src, "utf8");
console.log("patched OK, chars:", src.length);
