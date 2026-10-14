import { createInterface } from 'node:readline';

// A suite-owned ACP peer: the model is deterministic; Fleet, Cowork and the
// two daemons remain real published packages and separate processes.
const sessionId = `e2e-${process.pid}`;
let activePrompt;
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const update = text => send({ method: 'session/update', params: {
  sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
} });

createInterface({ input: process.stdin }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) {
    if (request.method === 'session/cancel' && activePrompt !== undefined) {
      send({ id: activePrompt, result: { stopReason: 'cancelled' } });
      activePrompt = undefined;
    }
    return;
  }
  switch (request.method) {
    case 'initialize':
      send({ id: request.id, result: {
        protocolVersion: 1,
        agentInfo: { name: 'ours-e2e-acp-peer', version: '1' },
        agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
      } });
      break;
    case 'session/new':
      send({ id: request.id, result: { sessionId, configOptions: [] } });
      break;
    case 'session/prompt': {
      activePrompt = request.id;
      const prompt = request.params?.prompt?.find(block => block.type === 'text')?.text ?? '';
      update(`E2E agent accepted briefing (${prompt.length} characters)`);
      send({ id: request.id, result: { stopReason: 'end_turn' } });
      activePrompt = undefined;
      break;
    }
    case 'session/close':
      send({ id: request.id, result: {} });
      break;
    default:
      send({ id: request.id, error: { code: -32601, message: `Unsupported ACP request: ${request.method}` } });
  }
});
