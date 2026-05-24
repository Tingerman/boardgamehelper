# Board Game RAG

一个基于 **智谱 AI（GLM）** 的桌游规则书问答系统。上传桌游 PDF 规则书后，可以用自然语言提问，系统会基于规则书内容给出准确回答。

前后端一体化部署：Express 后端 + 原生 HTML/JS 前端，同一个服务即可同时托管两者。

## 架构演进：直线 RAG → LangGraph

最初实现是直线 RAG：`embedding → cosine topK → 拼 prompt → 生成`。随着场景复杂化，直线代码很难做"按 query 类型分流"和"答完自检重答"，因此把核心控制流迁移到 **LangGraph StateGraph**，引入三个图原生能力：

1. **意图路由**（conditional edges）：N1 把 query 分为 `rag / off_topic / greeting`，闲聊和无关问题直接走 N5 固定文案，零 LLM 成本兜底。
2. **Hybrid 召回**（节点内 `Promise.all`）：N2 并发 dense + BM25，用 RRF 融合（k=60，topK=5），同时覆盖语义与关键词命中。
3. **自检循环**（反向边）：N4 用 LLM-as-Judge 判 `supported/partial/unsupported`，不达标且 retryCount<2 时回退 N3 重答，规避幻觉。

详见 [`server/agent/README.md`](./server/agent/README.md) 与图全貌 [`AGENT_GRAPH.md`](./AGENT_GRAPH.md)。旧 `rag.query()` 保留作 fallback。

## B 站规则书目录回退（bilibili-catalog-fallback）

启动时拉取 B 站某 up 主的桌游规则书合集元数据（zhName/enName/summary），扩展 LangGraph：

- **N6 catalog_check（双层）**：Layer 1 alias 硬匹配（~1ms），Layer 2 小模型 LLM 基于 summary 语义兜底（~300ms，confidence < 0.7 视同 miss）。
- **N7 ingest_pipeline**：catalog 命中但未入库时，实时 scrape opus → OCR → embed → 入库，全程 SSE 流式上报进度。
- **统一 metadata**：所有 ingest 路径（B 站 / PDF 上传）入库时都抽 zhName/enName/summary，让 matcher 池对称覆盖两种来源。
- **可观测埋点**：每次 N6 落 `server/metrics/n6.jsonl`，记录 `matchedBy / catalogStatus / latencyMs / confidence`，便于聚合硬匹配 vs LLM 兜底命中分布。

### SSE 协议

客户端 `Accept: text/event-stream` 触发 SSE 模式：

| event | data 字段 |
|-------|-----------|
| `route` | `{route, game, dynIdStr, matchedBy, matchConfidence}` —— catalog 命中需 ingest 时 emit |
| `ingest_progress` | `{stage, percent, current?, total?}` —— stage ∈ scrape/ocr/metadata/embed |
| `ingest_done` | `{bookId, chunks, durationMs}` |
| `op_log` | `{type, game?, url?, dynIdStr?, ...}` —— 常驻操作日志，type ∈ `scrape / scraped / catalog_hit / ingest_done / image_ingest_start / image_ingest_done`，前端浮窗展示并保留可点击的 B 站 URL |
| `answer` | `{answer, sources, intent, faithfulness, retryCount, catalogStatus, matchedBy, matchConfidence}` —— `sources[i]` 携带 `source` 与 `sourceMeta`（B 站源含 `imageUrls` 用于缩略图回贴）|
| `done` | `{}` |
| `error` | `{code, message?}` —— 错误码：`already_ingesting / ingest_failed / quota_exhausted / agent_error` |

非 SSE 模式（默认 JSON）：catalog 命中需 ingest 时直接返回 `{status:'need_ingest', game, dynIdStr}`，前端自行决定是否切 SSE 重发。

### 配置

`.env` 增加：

```
BILI_COLLECTION_ID=             # 合集 id，留空则跳过 catalog 加载
BAIDU_OCR_API_KEY=              # 百度智能云 OCR
BAIDU_OCR_SECRET_KEY=
N6_LLM_CONFIDENCE_THRESHOLD=0.7 # 可选，Layer 2 阈值
```

## 启动加速：book cache 持久化

冷启动避免重复跑 ingest pipeline，每本书 ingest 完成后落盘到 `data/cache/{bookId}.cache.json`，下次启动校验通过即直接反序列化进内存。

落盘内容：chunks + embeddings + metadata（zhName/enName/summary）+ 原始 text + pdfHash。失效条件（任一命中即整本重 ingest）：

| 字段 | 触发场景 |
|---|---|
| `schemaVersion` | 切分策略 / metadata prompt 变更后手动升 |
| `embeddingModel` / `embeddingDim` | 切换 embedding 模型 |
| `chunkSize` | 调整切块大小 |
| `pdfHash` | 源 PDF 内容被替换（B 站 ingest 来源 hash=null） |
| 文件损坏 / JSON parse 失败 | 异常兜底 |

写入用 `.tmp + rename` 原子语义。手动清缓存：删 `data/cache/{bookId}.cache.json`。

> **升级须知（schemaVersion=2）**：B 站源 chunk 新增 `imageIndices` 字段（OCR 文本对应的图片下标）。启动时旧 v1 cache 会被自动删除并打 `[cache] outdated schemaVersion=1→2 ...` 日志，之后用户提问命中该书时按需重新抓取。

## chunk 级图片对齐 + LLM 显式 citation

B 站桌游条目通常一篇专栏里 9 张图（角色卡、技能卡、规则示意）。检索精细度做了两层优化：

- **chunk-image 对齐**：ingest 时把每张图的 OCR 文本前插 `<<IMG:n>>` sentinel 与正文一起切，chunk 切完反向扫 sentinel 写入 `metadata.imageIndices: number[]`。检索时按命中 chunk 的 imageIndices 从 `sourceMeta.imageUrls` 反查，前端 source 卡片只贴该段对应的原图（不再贴整篇 9 张）。
- **citation-aware 排序**：N3 LLM 输出严格 JSON `{answer, citedChunks}`，context 每段前置 `[chunk_N]` 编号供 LLM 引用。invokeAgent 末端按 cited 优先 + RRF score 兜底重排 sources，cited 的 source 卡片显示绿色"已引用"badge。解决 RRF 分数高的 chunk 不一定是答案真实来源的问题（例：`农场主支持几人玩` 的答案在 chunk 26，但 chunk 3 score 更高）。

## 功能特性

- PDF 规则书上传与自动解析
- LangGraph 驱动的多步骤问答（意图路由 + Hybrid 召回 + 自检循环）
- 使用智谱 AI `embedding-3` 做向量检索、`glm-4-flash` 生成回答
- 前端内置 Markdown 渲染与代码高亮
- 支持 Docker 一键部署

## 项目结构

```
.
├── public/              # 前端静态资源
│   ├── index.html
│   ├── app.js
│   └── style.css
├── server/              # 后端 Node 服务
│   ├── index.js         # Express 入口
│   ├── agent/           # LangGraph Agent（意图路由 + Hybrid + 自检）
│   │   ├── graph.mjs
│   │   ├── state.mjs
│   │   └── nodes/
│   ├── retrieval/       # BM25 索引
│   │   └── bm25.mjs
│   ├── rag/             # RAG 引擎（embedding + 文档存储；query 仅作 fallback）
│   │   ├── index.js
│   │   └── pdf.js
│   └── storage/         # 向量/索引持久化
├── data/
│   └── books/           # 规则书 PDF 存放目录
├── Dockerfile
├── docker-compose.yml
├── package.json
└── .env.example         # 环境变量模板
```

## 快速开始

### 1. 克隆仓库

```bash
git clone <仓库地址>
cd innovation
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

在 `.env` 中填入你的智谱 AI API Key（前往 <https://open.bigmodel.cn/usercenter/apikeys> 获取）：

```
ZHIPU_API_KEY=your_api_key_here
```

### 3. 本地运行

```bash
npm install
npm start
```

启动后访问：<http://localhost:3000>

开发模式（文件变更自动重启）：

```bash
npm run dev
```

### 4. 使用 Docker 部署

```bash
docker compose up -d
```

服务会在 `http://<host>:3000` 对外提供。

> 注意：`docker-compose.yml` 未加载 `.env`，如需在容器内使用 API Key，请在 `docker-compose.yml` 的 `environment` 下新增：
> ```yaml
> - ZHIPU_API_KEY=${ZHIPU_API_KEY}
> ```
> 并在宿主机执行 `export ZHIPU_API_KEY=xxx` 或使用 `env_file: .env`。

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/status`       | 获取系统状态 |
| GET  | `/api/books`        | 获取已导入的规则书列表 |
| POST | `/api/ingest`       | 上传并导入 PDF（`multipart/form-data`，字段 `pdf` + 可选 `name/zhName/enName/summary`）|
| POST | `/api/ingest/image` | 上传图片并 OCR 入库（`multipart/form-data`，字段 `images[]` + 可选 metadata；**响应为 SSE**）|
| POST | `/api/ingest/url`   | 粘贴 B 站 opus URL 入库（JSON `{url, zhName?, enName?, summary?}`；**响应为 SSE**）|
| POST | `/api/query`        | 提问（`{ question, bookId? }`）|
| DELETE | `/api/books/:id`  | 删除规则书（含 cache 文件） |

### 多源入库（multi-source-ingest）

支持三种数据源，共享一套 metadata 抽取流程：

- **PDF**：解析全文 → ingest
- **图片**：串行 OCR 每张图（失败率 > 50% 报错）→ 拼接文本 → ingest
- **B 站 opus URL**：scrape 正文 + OCR 图片 → ingest

三者共享 metadata 三字段：`zhName`/`enName`/`summary`。语义为**全有或全无**：
- 用户填了任意一个 → 三字段均以用户输入为准（未填字段保持空），**跳过 LLM 抽取**
- 用户三个都没填 → 走 LLM 自动抽取（glm-4-flash，T=0）

图片和 URL 路由返回 SSE 流（`event: ingest_progress | ingest_done | error`），便于前端展示分阶段进度（scrape / ocr / metadata / embed）。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `ZHIPU_API_KEY` | 是 | 智谱 AI 开放平台 API Key |
| `PORT` | 否 | 服务端口，默认 `3000` |
| `ZHIPU_CHAT_MODEL` | 否 | 对话模型，默认 `glm-4-flash` |
| `ZHIPU_EMBEDDING_MODEL` | 否 | 嵌入模型，默认 `embedding-3` |
| `ZHIPU_EMBEDDING_DIM` | 否 | 嵌入维度，默认 `1024` |

## 部署建议

- **云主机（推荐）**：`docker compose up -d`
- **Railway / Render / Fly.io**：连接 GitHub 仓库自动构建，注意在平台控制台配置 `ZHIPU_API_KEY`
- **裸机**：`npm install --production && node server/index.js`，建议配合 `pm2` 守护

运行本地/部分嵌入任务时建议至少 2GB 内存（`docker-compose.yml` 已配置 2G 预留、4G 上限）。

## 许可证

MIT
