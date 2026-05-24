// N5 refuse（不调 LLM，固定文案）
//
// 处理两种意图：
//   - greeting  → 友好问候 + 提示能力范围
//   - off_topic → 直白拒答，引导回桌游话题

const REPLIES = {
  greeting:
    '你好！我是桌游规则助手，可以问我关于已入库桌游的规则问题，比如计分、卡牌效果、回合流程等。',
  off_topic:
    '抱歉，我只能回答桌游规则相关的问题。如果你想了解某款桌游的玩法或规则细节，欢迎提问。',
};

export function refuseNode(state) {
  const reply = REPLIES[state.intent] || REPLIES.off_topic;
  return {
    answer: reply,
    sources: [],
    faithfulness: 'supported',
  };
}
