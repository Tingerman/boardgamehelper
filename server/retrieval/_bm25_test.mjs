// 独立测试：验证 BM25 排序合理性
import { BM25Index, tokenize } from './bm25.mjs';

const idx = new BM25Index();
idx.addDocument('d1', 'Through the Ages 第二轮结束时玩家根据军力计分');
idx.addDocument('d2', 'Ark Nova 方舟动物园是一款动物园主题的策略桌游');
idx.addDocument('d3', '玩家在第二轮可以建造新的建筑，建筑会带来分数');
idx.addDocument('d4', 'BGA 是 Board Game Arena 的缩写，可以在线玩桌游');
idx.addDocument('d5', '军力是 Through the Ages 中重要的资源，影响殖民和侵略');

console.log('--- tokenize tests ---');
console.log('英文混中文:', tokenize('Through 第二轮'));
console.log('纯中文:', tokenize('军力计分'));

console.log('\n--- search tests ---');
const cases = [
  '第二轮怎么计分',
  'Through the Ages 军力',
  'Ark Nova',
  '方舟',
  '不存在的关键词xyzzy',
];
for (const q of cases) {
  const hits = idx.search(q, 3);
  console.log(`Q: ${q}`);
  for (const h of hits) {
    console.log(`  ${h.id}  score=${h.score.toFixed(3)}`);
  }
}

console.log('\n--- removeDocument test ---');
idx.removeDocument('d1');
console.log('after remove d1, size:', idx.size());
const after = idx.search('第二轮计分', 3);
console.log('search 第二轮计分:', after);
