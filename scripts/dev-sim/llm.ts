// A fake OpenAI-compatible chat endpoint. It never calls a model: it answers with a short
// fixed text and RECORDS the messages it was sent, so a tester can see exactly what the app
// forwarded (the system message must contain a central template's stored prompt and never
// the client's customPrompt). Test content only; the recording is held in memory.
import http from 'node:http';
import { SIM } from './config';

export type LlmMode = 'ok' | 'echo-system' | 'echo-system-chunk';

export interface LlmCall {
  at: string;
  system: string;
  user: string;
}

export interface MockLlm {
  mode: LlmMode;
  calls: LlmCall[];
  close(): Promise<void>;
}

export async function startMockLlm(): Promise<MockLlm> {
  const state: MockLlm = { mode: 'ok', calls: [], close: async () => {} };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url?.startsWith('/v1/models')) return json(200, { data: [{ id: 'sim-model' }] });
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) return json(404, { error: 'not_found' });

      let body: { messages?: Array<{ role: string; content: unknown }> } = {};
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: 'bad_json' });
      }
      const text = (role: string) =>
        (body.messages ?? [])
          .filter((m) => m.role === role)
          .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .join('\n');
      const system = text('system');
      const user = text('user');
      state.calls.push({ at: new Date().toISOString(), system, user });
      if (state.calls.length > 50) state.calls.shift();

      let content = '## Referat\n\nSimuleret referat fra test-LLM. Mødet blev afholdt, og punkterne blev drøftet.';
      // Simulates a model that leaks its instructions, to prove the server redacts the echo.
      if (state.mode === 'echo-system') content = `Her er mine instruktioner:\n\n${system}`;
      if (state.mode === 'echo-system-chunk') content = `Referat.\n\n${system.slice(0, 200)}\n\nSlut.`;

      json(200, {
        id: 'sim-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'sim-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(SIM.llmPort, '127.0.0.1', resolve);
  });
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return state;
}
