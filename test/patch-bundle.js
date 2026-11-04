// 补丁 v5.1（分屏自适应·rulers 载体·终版）：补丁1（暴露 editor）+ 补丁2（兜底注册+flag）+ 补丁3：
//   computeLayout 头部：门控(__ceGate) + 从本编辑器的 rulers 选项（EditorOption 117）读内缩量 __ceP
//     （inject.js 通过 updateOptions({rulers:[{column:pad,color:透明}]}) 按每个编辑器独立写入）
//   返回值：glyphMargin/行号/装饰/contentLeft += __ceP；contentWidth -= 2*__ceP；minimapLeft -= __ceP。
//   rulers 是每编辑器独立的真实 option → 分屏时各组互不干扰；透明色不可见。
// 用法: node patch-v5.js <干净bundle路径> <输出路径>
const fs = require('fs');

const srcPath = process.argv[2], outPath = process.argv[3];
if (!srcPath || !outPath) { console.error('usage: node patch-v5.js <src> <out>'); process.exit(1); }
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

// ---- 补丁 3b：返回值 —— 左链整体内缩 + contentWidth 收缩 + minimap 左移 ----
// ⚠️ 锚点带 {width:/height: 前缀时，替换文本必须重新输出它们（漏了会丢字段，已踩过一次）
const a3r = /\{width:(\w+),height:(\w+),glyphMarginLeft:(\w+),glyphMarginWidth:(\w+),glyphMarginDecorationLaneCount:([\w$.]+),lineNumbersLeft:(\w+),lineNumbersWidth:(\w+),decorationsLeft:(\w+),decorationsWidth:(\w+),contentLeft:(\w+),contentWidth:(\w+),minimap:(\w+)/;
{
  const n = src.match(new RegExp(a3r.source, 'g'));
  if (!n || n.length !== 1) { console.error('锚点3返回 匹配 ' + (n ? n.length : 0) + ' 处，放弃'); process.exit(1); }
  src = src.replace(a3r,
    '{width:$1,height:$2,' +
    'glyphMarginLeft:$3+__ceP,glyphMarginWidth:$4,glyphMarginDecorationLaneCount:$5,' +
    'lineNumbersLeft:$6+__ceP,lineNumbersWidth:$7,decorationsLeft:$8+__ceP,decorationsWidth:$9,' +
    'contentLeft:$10+__ceP,contentWidth:Math.max(1,$11-2*__ceP),' +
    'minimap:(function(l){if(!__ceP)return l;var m={},k;for(k in l)m[k]=l[k];' +
    'if(l.renderMinimap!==0&&l.minimapLeft>0)m.minimapLeft=l.minimapLeft-__ceP;return m})($12)');
}

fs.writeFileSync(outPath, src, 'utf8');
console.log('patched v5.1 OK, chars:', src.length);
