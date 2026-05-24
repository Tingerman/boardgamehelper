// SSE 响应封装
//
// 用法：
//   const sse = createSseResponse(res);
//   sse.emit('route', { ... });
//   ...
//   sse.end();
//
// 客户端断开后 res.write 会失败，emit 内 catch 吞掉，让 ingest 任务跑完。

function formatEvent(event, data) {
  const payload = JSON.stringify(data ?? {});
  return `event: ${event}\ndata: ${payload}\n\n`;
}

export function createSseResponse(res) {
  let closed = false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 禁用 nginx 缓冲
  });
  // 立即 flush headers
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  res.on('close', () => { closed = true; });

  function emit(event, data) {
    if (closed) return false;
    try {
      res.write(formatEvent(event, data));
      return true;
    } catch (err) {
      closed = true;
      return false;
    }
  }

  function end() {
    if (closed) return;
    try { res.end(); } catch (_) {}
    closed = true;
  }

  function isClosed() { return closed; }

  return { emit, end, isClosed };
}

export const _formatEvent = formatEvent;
