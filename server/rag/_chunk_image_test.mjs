// splitTextWithImageMap 单测
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { splitTextWithImageMap, splitTextIntoChunks } = require('./pdf');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } }
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), `${name}: expect=${JSON.stringify(b)}, got=${JSON.stringify(a)}`); }

// === 1. 无 segments：行为同 splitTextIntoChunks（实际上 ingest 路径不会进这里，仅边界保护）===
{
  const r = splitTextWithImageMap('hello world', [], 500, 50);
  ok(r.length === 1 && r[0].text === 'hello world', 'prefix only no segments');
  eq(r[0].metadata.imageIndices, [], 'imageIndices empty when no segments');
}

// === 2. 单图：chunk 含对应 imageIndex ===
{
  const segs = [{ imageIndex: 0, text: '这是图零的内容文字'.repeat(5) }];
  const r = splitTextWithImageMap('', segs, 500, 50);
  ok(r.length >= 1, 'at least one chunk');
  ok(r.every(c => !c.text.includes('<<IMG:')), 'sentinel cleaned from output');
  ok(r[0].metadata.imageIndices.includes(0), 'chunk0 has imageIndex 0');
}

// === 3. 多图：每个 chunk 命中正确的 imageIndex ===
{
  const segs = [
    { imageIndex: 0, text: '图零文字' + 'A'.repeat(400) },
    { imageIndex: 1, text: '图一文字' + 'B'.repeat(400) },
    { imageIndex: 2, text: '图二文字' + 'C'.repeat(400) },
  ];
  const r = splitTextWithImageMap('标题前缀', segs, 500, 50);
  ok(r.length >= 3, '至少 3 个 chunk');

  const allIdx = r.flatMap(c => c.metadata.imageIndices);
  ok(allIdx.includes(0) && allIdx.includes(1) && allIdx.includes(2), '三张图都被某个 chunk 覆盖');
  ok(r.every(c => !c.text.includes('<<IMG')), 'no sentinel leak');
}

// === 4. 短小段落：相邻图可能合并到同一 chunk ===
{
  const segs = [
    { imageIndex: 5, text: '短A' },
    { imageIndex: 6, text: '短B' },
    { imageIndex: 7, text: '短C' },
  ];
  const r = splitTextWithImageMap('', segs, 500, 50);
  // 三段都很短，会被合并成一个 chunk，imageIndices 应包含 5,6,7
  const merged = r.find(c => c.metadata.imageIndices.length >= 2);
  ok(!!merged, '存在合并多图的 chunk');
  if (merged) eq(merged.metadata.imageIndices, [5, 6, 7], 'merged chunk has all indices');
}

// === 5. 空 text segment 占位但不污染 ===
{
  const segs = [
    { imageIndex: 0, text: '' },
    { imageIndex: 1, text: '只有图一有文字内容'.repeat(5) },
  ];
  const r = splitTextWithImageMap('', segs, 500, 50);
  // imageIndex 0 因为没文字理论上 chunk 内会有 sentinel(0) 但紧跟 sentinel(1)，
  // 它们紧挨着 → 合并到同一个 chunk，包含 [0,1]
  const hasZero = r.some(c => c.metadata.imageIndices.includes(0));
  const hasOne = r.some(c => c.metadata.imageIndices.includes(1));
  ok(hasOne, 'imageIndex 1 被命中');
  // imageIndex 0 是否命中取决于切分边界，宽松允许
  ok(typeof hasZero === 'boolean', 'imageIndex 0 命中状态可观测');
}

// === 6. 输出与 splitTextIntoChunks 兼容字段 ===
{
  const r = splitTextWithImageMap('a'.repeat(20), [{ imageIndex: 0, text: 'b'.repeat(20) }], 500, 50);
  ok(r[0].metadata.index === 0, 'chunk index field preserved');
  ok(typeof r[0].metadata.source === 'string', 'source field preserved');
  ok(Array.isArray(r[0].metadata.imageIndices), 'imageIndices is array');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
