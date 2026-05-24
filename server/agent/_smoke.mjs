// Smoke test：验证 LangGraph 安装可用
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';

const State = Annotation.Root({
  msg: Annotation(),
});

const graph = new StateGraph(State)
  .addNode('hello', (state) => ({ msg: (state.msg ?? '') + ' world' }))
  .addEdge(START, 'hello')
  .addEdge('hello', END)
  .compile();

const result = await graph.invoke({ msg: 'hello' });
console.log('[smoke] result:', result);
if (result.msg !== 'hello world') {
  console.error('[smoke] FAIL: expected "hello world", got', JSON.stringify(result));
  process.exit(1);
}
console.log('[smoke] OK');
