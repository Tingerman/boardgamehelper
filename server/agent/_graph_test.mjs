// 端到端图测试（mock LLM 客户端避免消耗真 API）
import { setDeps } from './deps.mjs';
import { invokeAgent } from './graph.mjs';

const fakeRag = {
  client: {
    async chat(messages, opts) {
      const sysContent = (messages.find(m => m.role === 'system')?.content || '');
      const userContent = (messages.find(m => m.role === 'user')?.content || '');
      // 根据 system prompt 关键词判断当前是哪个节点在调
      if (sysContent.includes('意图分类器')) {
        if (userContent.includes('你好')) return '{"intent":"greeting"}';
        if (userContent.includes('天气')) return '{"intent":"off_topic"}';
        return '{"intent":"rag"}';
      }
      if (sysContent.includes('答案校验器')) {
        return '{"verdict":"supported","reason":"all good"}';
      }
      // 默认认为是 N3 answer
      return '第二轮结束时按军力计分（mock 答案）';
    },
  },
  async getEmbedding(_text) {
    // 返回 4 维假向量
    return [0.1, 0.2, 0.3, 0.4];
  },
  cosineSimilarity(_a, _b) {
    return 0.9;
  },
  getDocuments() {
    return [
      {
        id: 'mock::0',
        pageContent: 'Through the Ages 第二轮结束时玩家根据军力计分',
        embedding: [0.1, 0.2, 0.3, 0.4],
        metadata: { bookId: 'mock', bookName: 'TtA-mock', chunkIndex: 0 },
      },
      {
        id: 'mock::1',
        pageContent: '军力是 Through the Ages 中的资源',
        embedding: [0.1, 0.2, 0.3, 0.4],
        metadata: { bookId: 'mock', bookName: 'TtA-mock', chunkIndex: 1 },
      },
    ];
  },
  getBm25() {
    return null; // 关掉 BM25 测纯 dense 路径
  },
};

setDeps({ rag: fakeRag });

const cases = [
  { q: '你好', expectIntent: 'greeting' },
  { q: '今天天气怎么样', expectIntent: 'off_topic' },
  { q: 'Through the Ages 第二轮怎么计分', expectIntent: 'rag' },
];

for (const { q, expectIntent } of cases) {
  const res = await invokeAgent(q);
  const ok = res.intent === expectIntent;
  console.log(`${ok ? 'PASS' : 'FAIL'}  Q="${q}"  intent=${res.intent}  answer="${(res.answer || '').slice(0, 60)}"  retry=${res.retryCount}`);
  if (!ok) process.exit(1);
}
console.log('\nALL OK');
