// 节点依赖注入（最小化 CJS↔ESM 桥）
//
// server/index.js 启动时调一次 setDeps({ rag })，
// 各节点通过 getDeps() 读取共享的 rag / bm25 / chat 客户端。

let _deps = null;

export function setDeps(deps) {
  _deps = deps;
}

export function getDeps() {
  if (!_deps) throw new Error('Agent deps not initialized; call setDeps() first');
  return _deps;
}
