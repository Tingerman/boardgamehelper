# LangGraph Agent

桌游规则 RAG 的核心控制流，从直线 RAG 迁移到 StateGraph 后获得三个图原生能力：意图路由、Hybrid 召回、自检循环。

## 架构图（本期：N1–N5）

```
            ┌──────────────┐
   query ─► │ N1 detect_   │
            │   intent     │
            └──────┬───────┘
                   │
        ┌──────────┼─────────────┐
        │ rag      │ off_topic   │ greeting
        ▼          ▼             ▼
  ┌──────────┐  ┌─────────────────────┐
  │ N2       │  │  N5 refuse          │
  │ hybrid_  │  │  （固定文案，零 LLM）│
  │ retrieve │  └──────────┬──────────┘
  └────┬─────┘             │
       │                   ▼
       ▼                  END
  ┌──────────┐
  │ N3       │ ◄─────────┐
  │ do_answer│           │ retryCount += 1
  └────┬─────┘           │
       ▼                 │
  ┌──────────────┐       │
  │ N4 do_       │       │
  │ faithfulness │ ──────┘ partial/unsupported
  └────┬─────────┘   且 retryCount < 2
       │ supported
       │ 或 retryCount >= 2
       ▼
      END
```

## 节点职责

| 节点 | 文件 | 职责 | 模型温度 |
|------|------|------|---------|
| N1 detect_intent | `nodes/intent.mjs` | 三分类：rag / off_topic / greeting，JSON 输出 | T=0 |
| N2 hybrid_retrieve | `nodes/retrieve.mjs` | `Promise.all` 并发 dense + BM25 → RRF 融合（k=60，topK=5） | — |
| N3 do_answer | `nodes/answer.mjs` | 严格基于 context 答题，重试时拼接更严格指令 | T=0.3 |
| N4 do_faithfulness | `nodes/faithfulness.mjs` | LLM-as-Judge：supported / partial / unsupported | T=0 |
| retry | 内联在 `graph.mjs` | 累加 retryCount（reducer 自动合并） | — |
| N5 refuse | `nodes/refuse.mjs` | greeting/off_topic 共用，零 LLM 成本 | — |

## State 字段（`state.mjs`）

| 字段 | 类型 | reducer | 说明 |
|------|------|---------|------|
| question | string | replace | 原始 query |
| bookId | string\|null | replace | bookId 过滤（可选） |
| intent | string | replace | rag / off_topic / greeting |
| bm25Hits / denseHits | array | replace | 两路召回原始结果 |
| mergedHits | array | replace | RRF 融合后 topK=5 |
| context | string | replace | 拼接的上下文（送 N3） |
| answer | string | replace | 最终答案 |
| faithfulness | string | replace | 校验结论 |
| retryCount | number | `(curr, add) => curr + add` | 累加，上限 2 |
| sources | array | replace | 返回前端用 |

## 关键设计决策

1. **节点名前缀 `do_`**：LangGraph 不允许节点名与 state 字段同名，所以 `answer` / `faithfulness` 节点重命名为 `do_answer` / `do_faithfulness`。
2. **BM25 同步在 ingest 时**：BM25 索引在 `rag/index.js` 的 `ingestDocument` / `deleteBook` 同步维护，不放进图里——图只负责检索，副作用前置。
3. **RRF 而非 rerank**：用 rank-based 融合避开 BM25 与 cosine 分数不同尺度的问题；rerank（cross-encoder）是后续可叠加的精排层，不在本期。
4. **N4 降级策略**：JSON 解析失败时 fallback 为 `supported`，避免无限重试。
5. **CJS↔ESM 桥接**：LangGraph 仅 ESM，主项目是 CJS。`server/index.js` 用动态 `import()` 懒加载 ESM agent，并通过 `deps.mjs` 注入 RAG 实例。

## 入口

```js
// server/index.js
const invoke = await loadAgent();          // 动态 import + setDeps({ rag })
const result = await invoke(question, { bookId });
// => { answer, sources, intent, faithfulness, retryCount }
```

异常时回退到 `rag.query()`（旧直线路径，保留作为 fallback）。

## 后续扩展（不在本期）

- **多语言扇出**（Send API）：在 N2 之前根据规则书语言并发出多路召回 → reduce 合并
- **B 站目录回退**（catalog fallback）：低召回时触发外部数据源补全
- **Rerank 精排层**：在 RRF 之后加 cross-encoder
- **流式输出**：N3 用 LangGraph 的 streaming 接口替换 chat
