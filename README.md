# Board Game RAG

一个基于 **智谱 AI（GLM）** 的桌游规则书问答系统。上传桌游 PDF 规则书后，可以用自然语言提问，系统会基于规则书内容给出准确回答。

前后端一体化部署：Express 后端 + 原生 HTML/JS 前端，同一个服务即可同时托管两者。

## 功能特性

- PDF 规则书上传与自动解析
- 基于 RAG（检索增强生成）的问答
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
│   ├── rag/             # RAG 引擎（检索 + 生成）
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
| POST | `/api/ingest`       | 上传并导入 PDF（`multipart/form-data`，字段名 `pdf`）|
| POST | `/api/query`        | 提问（`{ question, bookId? }`）|
| DELETE | `/api/books/:id`  | 删除规则书（仅内存） |

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `ZHIPU_API_KEY` | 是 | 智谱 AI 开放平台 API Key |
| `PORT` | 否 | 服务端口，默认 `3000` |
| `ZHIPU_CHAT_MODEL` | 否 | 对话模型，默认 `glm-4-flash` |
| `ZHIPU_EMBEDDING_MODEL` | 否 | 嵌入模型，默认 `embedding-3` |
| `ZHIPU_EMBEDDING_DIM` | 否 | 嵌入维度，默认 `1024` |

## 推送到 Git

```bash
git init
git add .
git commit -m "init: board game RAG"
git branch -M main
git remote add origin <你的仓库地址>
git push -u origin main
```

> `.env`、`node_modules/`、`data/temp/` 已在 `.gitignore` 中排除，不会被提交。
> `data/books/` 下的 PDF **会** 被提交，如不希望提交样例 PDF，请在 `.gitignore` 中添加 `data/books/*.pdf`。

## 部署建议

- **云主机（推荐）**：`docker compose up -d`
- **Railway / Render / Fly.io**：连接 GitHub 仓库自动构建，注意在平台控制台配置 `ZHIPU_API_KEY`
- **裸机**：`npm install --production && node server/index.js`，建议配合 `pm2` 守护

运行本地/部分嵌入任务时建议至少 2GB 内存（`docker-compose.yml` 已配置 2G 预留、4G 上限）。

## 许可证

MIT
