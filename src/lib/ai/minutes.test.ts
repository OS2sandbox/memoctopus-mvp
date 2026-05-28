import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockComplete = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mockComplete } };
  },
}));

import { suggestTemplate, generateMinutes, generateMinutesFreeform } from './minutes';
import type { TranscriptSegment, TemplateSectionDef } from '@/types';

const sampleSegments: TranscriptSegment[] = [
  { speaker: 'Taler 1', start: 0, end: 5, text: 'Vi åbner mødet.' },
  { speaker: 'Taler 2', start: 6, end: 10, text: 'Første punkt på dagsordenen.' },
];

const sampleTemplates = [
  { id: 'tmpl-1', name: 'Bestyrelsesmøde', description: 'Til bestyrelsesmøder' },
  { id: 'tmpl-2', name: 'Personalemøde', description: 'Til personalemøder' },
];

const sampleSections: TemplateSectionDef[] = [
  { key: 'deltagere', label: 'Deltagere', required: true },
  { key: 'beslutninger', label: 'Beslutninger', description: 'Vigtige beslutninger', required: true },
  { key: 'noter', label: 'Noter', required: false },
];

function openaiResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

// ─── suggestTemplate ──────────────────────────────────────────────────────────

describe('suggestTemplate', () => {
  beforeEach(() => mockComplete.mockReset());

  it('returns the suggested template from OpenAI', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          templateId: 'tmpl-1',
          templateName: 'Bestyrelsesmøde',
          explanation: 'Passer til en bestyrelse.',
        }),
      ),
    );

    const result = await suggestTemplate(sampleSegments, sampleTemplates);

    expect(result.templateId).toBe('tmpl-1');
    expect(result.templateName).toBe('Bestyrelsesmøde');
    expect(result.explanation).toBe('Passer til en bestyrelse.');
  });

  it('strips markdown code fences before parsing', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        '```json\n{"templateId":"tmpl-2","templateName":"Personalemøde","explanation":"X"}\n```',
      ),
    );

    const result = await suggestTemplate(sampleSegments, sampleTemplates);
    expect(result.templateId).toBe('tmpl-2');
  });

  it('falls back gracefully when JSON parse fails', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('invalid json'));

    const result = await suggestTemplate(sampleSegments, sampleTemplates);

    expect(result.templateId).toBeNull();
    expect(result.templateName).toBe('Bestyrelsesmøde'); // first template name
    expect(result.explanation).toBeTruthy();
  });

  it('falls back with "Standard" when templates array is empty', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('bad json'));

    const result = await suggestTemplate(sampleSegments, []);
    expect(result.templateName).toBe('Standard');
  });

  it('truncates transcript to 3000 chars in the prompt', async () => {
    const longSegments: TranscriptSegment[] = Array.from({ length: 200 }, (_, i) => ({
      speaker: 'Taler 1',
      start: i,
      end: i + 1,
      text: 'Dette er en lang sætning der fylder meget i transskriptionen.',
    }));

    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({ templateId: null, templateName: 'Standard', explanation: 'x' }),
      ),
    );

    await suggestTemplate(longSegments, sampleTemplates);

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[1].content as string;
    const parts = userContent.split('Transskription:\n');
    expect(parts).toHaveLength(2);
    const transcriptPart = parts[1].split('\n\nReturner JSON:')[0];
    expect(transcriptPart.length).toBeLessThanOrEqual(3000);
  });

  it('includes template names and descriptions in the prompt', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(JSON.stringify({ templateId: 'tmpl-1', templateName: 'X', explanation: 'y' })),
    );

    await suggestTemplate(sampleSegments, sampleTemplates);

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[1].content as string;
    expect(userContent).toContain('Bestyrelsesmøde');
    expect(userContent).toContain('Personalemøde');
    expect(userContent).toContain('tmpl-1');
  });

  it('includes transcript text in the prompt', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(JSON.stringify({ templateId: null, templateName: 'X', explanation: 'y' })),
    );

    await suggestTemplate(sampleSegments, sampleTemplates);

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[1].content as string;
    expect(userContent).toContain('Vi åbner mødet.');
  });

  it('uses gpt-4o model', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(JSON.stringify({ templateId: null, templateName: 'X', explanation: 'y' })),
    );

    await suggestTemplate(sampleSegments, sampleTemplates);

    const call = mockComplete.mock.calls[0][0];
    expect(call.model).toBe('gpt-4o');
  });
});

// ─── generateMinutes ──────────────────────────────────────────────────────────

describe('generateMinutes', () => {
  beforeEach(() => mockComplete.mockReset());

  it('returns sections from OpenAI response', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          sections: [
            { key: 'deltagere', label: 'Deltagere', content: '- Taler 1\n- Taler 2' },
            { key: 'beslutninger', label: 'Beslutninger', content: 'Ingen.' },
            { key: 'noter', label: 'Noter', content: '' },
          ],
        }),
      ),
    );

    const result = await generateMinutes(sampleSegments, sampleSections);

    expect(result.sections).toHaveLength(3);
    expect(result.sections[0].key).toBe('deltagere');
    expect(result.sections[0].content).toBe('- Taler 1\n- Taler 2');
  });

  it('strips markdown code fences before parsing', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        '```json\n{"sections":[{"key":"k","label":"L","content":"C"}]}\n```',
      ),
    );

    const result = await generateMinutes(sampleSegments, [{ key: 'k', label: 'L', required: true }]);
    expect(result.sections[0].content).toBe('C');
  });

  it('falls back to empty sections matching the template when JSON parse fails', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('not valid json'));

    const result = await generateMinutes(sampleSegments, sampleSections);

    expect(result.sections).toHaveLength(sampleSections.length);
    result.sections.forEach((s) => expect(s.content).toBe(''));
    expect(result.sections.map((s) => s.key)).toEqual(sampleSections.map((s) => s.key));
  });

  it('includes section keys and labels in the prompt', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse(JSON.stringify({ sections: [] })));

    await generateMinutes(sampleSegments, sampleSections);

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[1].content as string;
    expect(userContent).toContain('"deltagere"');
    expect(userContent).toContain('"Deltagere"');
    expect(userContent).toContain('"beslutninger"');
  });

  it('marks required sections as påkrævet in the prompt', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse(JSON.stringify({ sections: [] })));

    await generateMinutes(sampleSegments, sampleSections);

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[1].content as string;
    expect(userContent).toContain('påkrævet');
  });

  it('includes formatted timestamps in the transcript', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse(JSON.stringify({ sections: [] })));

    await generateMinutes(
      [{ speaker: 'Taler 1', start: 65, end: 70, text: 'Hej' }],
      sampleSections,
    );

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[1].content as string;
    // 65 seconds = 1:05
    expect(userContent).toContain('1:05');
  });

  it('includes section descriptions when present', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse(JSON.stringify({ sections: [] })));

    await generateMinutes(sampleSegments, sampleSections);

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[1].content as string;
    expect(userContent).toContain('Vigtige beslutninger');
  });

  it('sends customPrompt in user message when provided', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse(JSON.stringify({ sections: [] })));

    await generateMinutes(sampleSegments, sampleSections, 'Fokus på beslutninger');

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[1].content as string;
    expect(userContent).toContain('Fokus på beslutninger');
  });

  it('uses gpt-4o model', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse(JSON.stringify({ sections: [] })));

    await generateMinutes(sampleSegments, sampleSections);

    const call = mockComplete.mock.calls[0][0];
    expect(call.model).toBe('gpt-4o');
  });

  it('returns all section keys and labels from template in fallback', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('bad json'));

    const result = await generateMinutes(sampleSegments, sampleSections);
    expect(result.sections.map((s) => s.label)).toEqual(
      sampleSections.map((s) => s.label),
    );
  });
});

// ─── generateMinutesFreeform ──────────────────────────────────────────────────

describe('generateMinutesFreeform', () => {
  beforeEach(() => mockComplete.mockReset());

  it('returns sections from OpenAI response', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        JSON.stringify({
          sections: [
            { key: 'resumé', label: 'Resumé', content: 'Mødet omhandlede projektstatus.' },
            { key: 'handlinger', label: 'Handlinger', content: '- Opdater status.' },
          ],
        }),
      ),
    );

    const result = await generateMinutesFreeform(sampleSegments, 'Fokus på handlingspunkter');

    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].key).toBe('resumé');
    expect(result.sections[0].content).toBe('Mødet omhandlede projektstatus.');
  });

  it('strips markdown code fences before parsing', async () => {
    mockComplete.mockResolvedValueOnce(
      openaiResponse(
        '```json\n{"sections":[{"key":"s","label":"S","content":"C"}]}\n```',
      ),
    );

    const result = await generateMinutesFreeform(sampleSegments, 'kort referat');
    expect(result.sections[0].content).toBe('C');
  });

  it('falls back to empty sections array when JSON parse fails', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse('not valid json'));

    const result = await generateMinutesFreeform(sampleSegments, 'prompt');
    expect(result.sections).toHaveLength(0);
  });

  it('includes custom prompt in user message', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse(JSON.stringify({ sections: [] })));

    await generateMinutesFreeform(sampleSegments, 'Lav et kortfattet referat');

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[1].content as string;
    expect(userContent).toContain('Lav et kortfattet referat');
  });

  it('includes transcript text in the prompt', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse(JSON.stringify({ sections: [] })));

    await generateMinutesFreeform(sampleSegments, 'prompt');

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[1].content as string;
    expect(userContent).toContain('Vi åbner mødet.');
  });

  it('includes formatted timestamps in the prompt', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse(JSON.stringify({ sections: [] })));

    await generateMinutesFreeform(
      [{ speaker: 'Taler 1', start: 125, end: 130, text: 'Punkt to' }],
      'referat',
    );

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[1].content as string;
    // 125 seconds = 2:05
    expect(userContent).toContain('2:05');
  });

  it('uses gpt-4o model', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse(JSON.stringify({ sections: [] })));

    await generateMinutesFreeform(sampleSegments, 'prompt');

    const call = mockComplete.mock.calls[0][0];
    expect(call.model).toBe('gpt-4o');
  });

  it('instructs OpenAI to decide sections itself', async () => {
    mockComplete.mockResolvedValueOnce(openaiResponse(JSON.stringify({ sections: [] })));

    await generateMinutesFreeform(sampleSegments, 'prompt');

    const call = mockComplete.mock.calls[0][0];
    const userContent = call.messages[1].content as string;
    expect(userContent).toContain('Beslut selv hvilke sektioner');
  });
});
