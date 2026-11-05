import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateReferatBody, type SkabelonSpec } from './minutes';
import { resetLlmClient } from './llm-client';
import { MinutesTooLongError } from './minutes-errors';
import type { TranscriptSegment } from '@/types';
import type { TranscriptChapter } from './chapters';

// Regression: every call minutes generation makes must fit the model's real context
// window when the app counts with vLLM's exact tokenizer. It used to cut parts by
// characters using the WHOLE transcript's chars/token ratio, so a part denser than
// average overflowed, and it never counted the chat template or the chapter title in
// the summary prompt. At 32768/8192 the first summary call asked for 34,793 tokens;
// vLLM answered 400 and the user saw a generic 500.
//
// The fake vLLM below is deliberately uneven: a speaker header costs far more tokens per
// character than running text, so a stretch of rapid back-and-forth tokenises much
// denser than a monologue. /tokenize counts a bare prompt (no chat template), exactly
// like vLLM's; the chat endpoint adds the template on top and rejects, with vLLM's
// 400, any request whose prompt plus max_tokens exceeds the window.

const CONTEXT = 32_768;
const TEMPLATE_TOKENS = 15; // <|im_start|>system … <|im_start|>assistant\n
const HEADER = /^\[[^\]]*\] \(\d+:\d\d\): /;

function fakeTokens(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    const m = line.match(HEADER);
    if (m) n += 9 + Math.ceil((line.length - m[0].length) / 2.8);
    else n += Math.ceil(line.length / 2.8);
  }
  return n;
}

interface ChatCall {
  promptTokens: number;
  maxTokens: number;
  isSummary: boolean;
  content: string;
}

const calls: ChatCall[] = [];
const tokenized: string[] = [];
// What the fake model answers to a summary prompt; the referat call always gets 'REFERAT'.
let summaryAnswer: (prompt: string) => string = () => '- punkt';
let server: http.Server;
let baseURL = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/tokenize') {
        tokenized.push(json.prompt);
        return res.end(JSON.stringify({ count: fakeTokens(json.prompt) }));
      }
      const messages = json.messages as { content: string }[];
      const promptTokens =
        messages.reduce((n, m) => n + fakeTokens(m.content), 0) + TEMPLATE_TOKENS;
      const last = messages[messages.length - 1].content;
      const isSummary = last.startsWith('Opsummer');
      calls.push({ promptTokens, maxTokens: json.max_tokens, isSummary, content: last });
      if (promptTokens + json.max_tokens > CONTEXT) {
        res.statusCode = 400;
        return res.end(
          // vLLM's (OpenAI-shaped) error body.
          JSON.stringify({
            error: {
              type: 'BadRequestError',
              code: 400,
              param: null,
              message:
                `This model's maximum context length is ${CONTEXT} tokens. However, you requested ` +
                `${promptTokens + json.max_tokens} tokens (${promptTokens} in the messages, ` +
                `${json.max_tokens} in the completion). Please reduce the length of the messages or completion.`,
            },
          }),
        );
      }
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: json.model,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: isSummary ? summaryAnswer(last) : 'REFERAT' },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const ENV = process.env;

beforeEach(() => {
  process.env = { ...ENV, LLM_BASE_URL: baseURL, LLM_MODEL: 'fake-model' };
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_CONTEXT_TOKENS;
  delete process.env.LLM_MAX_OUTPUT_TOKENS;
  delete process.env.VLLM_CHAT_MAX_MODEL_LEN;
  resetLlmClient();
  calls.length = 0;
  tokenized.length = 0;
  summaryAnswer = () => '- punkt';
});

afterEach(() => {
  process.env = ENV;
  resetLlmClient();
});

const spec: SkabelonSpec = {
  prompt: '',
  includeDeltagere: false,
  includeBeslutningspunkter: false,
  includeDagsorden: false,
  includeDato: false,
};

// A stretch of rapid back-and-forth (short turns, header-dense) followed by long
// monologues: the first stretch tokenises much denser than the transcript's average.
function unevenMeeting(): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  let t = 0;
  for (let i = 0; i < 1400; i++) {
    segs.push({ speaker: `Taler ${(i % 2) + 1}`, start: t, end: t + 3, text: 'Ja, det er jeg enig i, helt klart.' });
    t += 4;
  }
  for (let i = 0; i < 60; i++) {
    segs.push({ speaker: `Taler ${(i % 3) + 1}`, start: t, end: t + 60, text: 'ord '.repeat(500).trim() });
    t += 60;
  }
  return segs;
}

function expectEveryCallToFit() {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(c.promptTokens + c.maxTokens, `a call asked for ${c.promptTokens}+${c.maxTokens}`).toBeLessThanOrEqual(CONTEXT);
  }
}

describe('generateReferatBody against an exact tokenizer', () => {
  it('keeps every call inside the context window for an unevenly dense meeting', async () => {
    const { body } = await generateReferatBody(unevenMeeting(), spec);

    expect(body).toBe('REFERAT');
    expectEveryCallToFit();
    expect(calls.filter((c) => c.isSummary).length).toBeGreaterThan(1);
  });

  it('counts the chapter title of a summary prompt', async () => {
    const segments = unevenMeeting();
    // Absurdly long, so that leaving the title out of the count is measurable.
    const long = 'Et meget langt kapitelnavn om budget, drift og anlæg '.repeat(60);
    const chapters: TranscriptChapter[] = [
      {
        id: 'ch-0', title: `${long} (1)`, summary: '', startTime: 0, endTime: 5_600,
        segmentIndices: Array.from({ length: 1400 }, (_, i) => i),
      },
      {
        id: 'ch-1', title: `${long} (2)`, summary: '', startTime: 5_600, endTime: 9_200,
        segmentIndices: Array.from({ length: 60 }, (_, i) => i + 1400),
      },
    ];

    await generateReferatBody(segments, spec, undefined, chapters);

    expectEveryCallToFit();
  });

  it('keeps a second summary round inside the window too', async () => {
    // First-round summaries are long enough that, together, they overflow the referat call.
    summaryAnswer = (prompt) =>
      prompt.includes('"Opsummering') ? '- kort' : `- ${'langt punkt '.repeat(3000)}`;

    const { body } = await generateReferatBody(unevenMeeting(), spec);

    expect(body).toBe('REFERAT');
    expectEveryCallToFit();
    expect(calls.some((c) => c.isSummary && c.content.includes('"Opsummering'))).toBe(true);
  });

  it('leaves room for the chat template when the transcript only just fits', async () => {
    // Calibrate: what the fixed part of the referat prompt costs, template included.
    const tiny = { speaker: 'Taler 1', start: 0, end: 1, text: 'Hej.' };
    await generateReferatBody([tiny], spec);
    const fixedWithTemplate = calls[0].promptTokens - fakeTokens('[Taler 1] (0:00): Hej.');
    calls.length = 0;

    // A transcript that fits only if the chat template is forgotten: sent in one call it
    // overflows the window by a handful of tokens.
    const transcriptTokens = CONTEXT - 8_192 - fixedWithTemplate + 8;
    const text = 'x'.repeat(Math.floor((transcriptTokens - 9) * 2.8));
    expect(fakeTokens(`[Taler 1] (0:00): ${text}`)).toBe(transcriptTokens);

    await generateReferatBody([{ speaker: 'Taler 1', start: 0, end: 600, text }], spec);

    expectEveryCallToFit();
  });

  it('sends the transcript to the tokenizer once', async () => {
    await generateReferatBody(
      [
        { speaker: 'Taler 1', start: 0, end: 2, text: 'Hej.' },
        { speaker: 'Taler 2', start: 3, end: 5, text: 'Goddag.' },
      ],
      spec,
    );

    expect(tokenized.filter((p) => p === '[Taler 1] (0:00): Hej.\n[Taler 2] (0:03): Goddag.')).toHaveLength(1);
  });

  it('turns a context-length 400 from the model into MinutesTooLongError', async () => {
    // A window the app believes is larger than the model's real one: the request
    // overflows and vLLM answers 400. The user must get the "too long" message, not a 500.
    process.env.LLM_CONTEXT_TOKENS = String(CONTEXT * 2);
    const segs: TranscriptSegment[] = Array.from({ length: 200 }, (_, i) => ({
      speaker: `Taler ${(i % 2) + 1}`, start: i * 60, end: i * 60 + 59, text: 'ord '.repeat(300).trim(),
    }));

    await expect(generateReferatBody(segs, spec)).rejects.toBeInstanceOf(MinutesTooLongError);
  });
});
