// 离线生成打过补丁的 bundle（E2E 注入体 / 手工排障用）。
// 与 src/extension.js 的 patchBundle 保持同一套补丁：
//   补丁1  _createConfiguration：把每个 CodeEditor 实例放进 window.__ceEditors
//   补丁2  updateOptions：兜底注册 + window.__ceBundlePatched 标记
//   补丁3  computeLayout：门控(wordWrap=off 且宽度≥400) + 从 rulers(EditorOption 117) 读内缩量 __ceP，
//          返回值里 glyphMargin/行号/装饰/contentLeft += __ceP、contentWidth −= 2×__ceP；minimap 保持原生
//   补丁4  EditorScrollbar._setLayout：宿主容器 left 不动（正文位置 = 容器 left）、width += pad，
//          让竖/横滚动条与 overview ruler 贴回编辑器最右
// 用法: node test/patch-bundle.js <干净bundle路径> <输出路径>
const fs = require('fs');

const srcPath = process.argv[2], outPath = process.argv[3];
if (!srcPath || !outPath) { console.error('usage: node test/patch-bundle.js <src> <out>'); process.exit(1); }
let src = fs.readFileSync(srcPath, 'utf8');
const reg = '(window.__ceEditors||(window.__ceEditors=new Set)).add(this)';

// ---- 补丁 1：暴露 editor 实例 ----
const a1 = /_createConfiguration\((\w+),(\w+),(\w+),(\w+)\)\{return new ([\w$]+)\(\1,\2,\3,this\._domElement,\4\)\}/;
{
  const n = src.match(new RegExp(a1.source, 'g'));
  if (!n || n.length !== 1) { console.error('锚点1 匹配 ' + (n ? n.length : 0) + ' 处，放弃'); process.exit(1); }
  src = src.replace(a1, '_createConfiguration($1,$2,$3,$4){var __ce=new $5($1,$2,$3,this._domElement,$4);' + reg + ';return __ce}');
  if (!src.includes(';return __ce}')) { console.error('补丁1 自检失败：缺右花括号'); process.exit(1); }
}

// ---- 补丁 2：updateOptions 兜底注册 + flag ----
const a2 = /updateOptions\((\w+)\)\{this\._configuration\.updateOptions\(\1\|\|\{\}\)\}/;
{
  const n = src.match(new RegExp(a2.source, 'g'));
  if (n && n.length === 1) {
    src = src.replace(a2, 'updateOptions($1){this._configuration.updateOptions($1||{});' + reg + '}');
  }
  src = 'window.__ceBundlePatched=1;' + src;
}

// ---- 补丁 3a：computeLayout 头部 —— 门控 + 从 rulers 选项读内缩量 ----
// ⚠️ 替换文本结尾不加逗号（锚点不含逗号，加了会产出 |0,, 语法错误，已踩过两次）
const a3h = /computeLayout\((\w+),(\w+)\)\{let (\w+)=\2\.outerWidth\|0/;
{
  const n = src.match(new RegExp(a3h.source, 'g'));
  if (!n || n.length !== 1) { console.error('锚点3头 匹配 ' + (n ? n.length : 0) + ' 处，放弃'); process.exit(1); }
  src = src.replace(a3h,
    'computeLayout($1,$2){' +
    'var __ceGate=(function(){var w=$1.get(156);w=w==="inherit"?$1.get(155):w;' +
    'w=w==="inherit"?$1.get(151):w;return w==="off"&&$2.outerWidth>=400})();' +
    'var __ceK=$1.get(117)||[];' +
    'var __ceP=(__ceGate&&__ceK.length&&typeof __ceK[0].column==="number")?__ceK[0].column:0;' +
    'let $3=$2.outerWidth|0');
}

// ---- 补丁 3b：返回值 —— 左链整体内缩 + contentWidth 收缩（minimap 保持原生）----
// ⚠️ 锚点带 {width:/height: 前缀时，替换文本必须重新输出它们（漏了会丢字段，已踩过一次）
const a3r = /\{width:(\w+),height:(\w+),glyphMarginLeft:(\w+),glyphMarginWidth:(\w+),glyphMarginDecorationLaneCount:([\w$.]+),lineNumbersLeft:(\w+),lineNumbersWidth:(\w+),decorationsLeft:(\w+),decorationsWidth:(\w+),contentLeft:(\w+),contentWidth:(\w+),minimap:(\w+)/;
{
  const n = src.match(new RegExp(a3r.source, 'g'));
  if (!n || n.length !== 1) { console.error('锚点3返回 匹配 ' + (n ? n.length : 0) + ' 处，放弃'); process.exit(1); }
  src = src.replace(a3r,
    '{width:$1,height:$2,' +
    'glyphMarginLeft:$3+__ceP,glyphMarginWidth:$4,glyphMarginDecorationLaneCount:$5,' +
    'lineNumbersLeft:$6+__ceP,lineNumbersWidth:$7,decorationsLeft:$8+__ceP,decorationsWidth:$9,' +
    'contentLeft:$10+__ceP,contentWidth:Math.max(1,$11-2*__ceP),minimap:$12');
}

// ---- 补丁 4：EditorScrollbar._setLayout —— 正文容器只加宽，滚动条/overview ruler 贴右 ----
const a4 = /_setLayout\(\)\{let (\w+)=this\._context\.configuration\.options,(\w+)=\1\.get\(168\);this\.scrollbarDomNode\.setLeft\(\2\.contentLeft\),\1\.get\(81\)\.side==="right"\?this\.scrollbarDomNode\.setWidth\(\2\.contentWidth\+\2\.minimap\.minimapWidth\):this\.scrollbarDomNode\.setWidth\(\2\.contentWidth\),this\.scrollbarDomNode\.setHeight\(\2\.height\)\}/;
{
  const n = src.match(new RegExp(a4.source, 'g'));
  if (!n || n.length !== 1) { console.error('锚点4 匹配 ' + (n ? n.length : 0) + ' 处，放弃'); process.exit(1); }
  src = src.replace(a4,
    '_setLayout(){let $1=this._context.configuration.options,$2=$1.get(168);' +
    'var __ceW=$1.get(156);__ceW=__ceW==="inherit"?$1.get(155):__ceW;' +
    '__ceW=__ceW==="inherit"?$1.get(151):__ceW;' +
    'var __ceK=$1.get(117)||[];' +
    'var __ceSb=(__ceW==="off"&&$2.width>=400&&__ceK.length&&typeof __ceK[0].column==="number")?__ceK[0].column:0;' +
    // 左边界不动：正文位置 = 容器 left，动它会连正文一起挪走
    'this.scrollbarDomNode.setLeft($2.contentLeft),' +
    '$1.get(81).side==="right"?this.scrollbarDomNode.setWidth($2.contentWidth+__ceSb+$2.minimap.minimapWidth)' +
    ':this.scrollbarDomNode.setWidth($2.contentWidth+__ceSb),' +
    'this.scrollbarDomNode.setHeight($2.height)}');
}

fs.writeFileSync(outPath, src, 'utf8');
console.log('patched OK, chars:', src.length);
