import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: mockCreate };
  },
}));

import { suggestTemplate, generateMinutes } from './minutes';
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

// ─── suggestTemplate ──────────────────────────────────────────────────────────

describe('suggestTemplate', () => {
  beforeEach(() => mockCreate.mockReset());

  it('returns the suggested template from Claude', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            templateId: 'tmpl-1',
            templateName: 'Bestyrelsesmøde',
            explanation: 'Passer til en bestyrelse.',
          }),
        },
      ],
    });

    const result = await suggestTemplate(sampleSegments, sampleTemplates);

    expect(result.templateId).toBe('tmpl-1');
    expect(result.templateName).toBe('Bestyrelsesmøde');
    expect(result.explanation).toBe('Passer til en bestyrelse.');
  });

  it('strips markdown code fences before parsing', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: '```json\n{"templateId":"tmpl-2","templateName":"Personalemøde","explanation":"X"}\n```',
        },
      ],
    });

    const result = await suggestTemplate(sampleSegments, sampleTemplates);
    expect(result.templateId).toBe('tmpl-2');
  });

  it('falls back gracefully when JSON parse fails', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'invalid json' }],
    });

    const result = await suggestTemplate(sampleSegments, sampleTemplates);

    expect(result.templateId).toBeNull();
    expect(result.templateName).toBe('Bestyrelsesmøde'); // first template name
    expect(result.explanation).toBeTruthy();
  });

  it('falls back with "Standard" when templates array is empty', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'bad json' }],
    });

    const result = await suggestTemplate(sampleSegments, []);
    expect(result.templateName).toBe('Standard');
  });

  it('throws when Claude returns non-text content', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'x', name: 'fn', input: {} }],
    });

    await expect(suggestTemplate(sampleSegments, sampleTemplates)).rejects.toThrow(
      'Unexpected response from Claude',
    );
  });

  it('truncates transcript to 3000 chars in the prompt', async () => {
    const longSegments: TranscriptSegment[] = Array.from({ length: 200 }, (_, i) => ({
      speaker: 'Taler 1',
      start: i,
      end: i + 1,
      text: 'Dette er en lang sætning der fylder meget i transskriptionen.',
    }));

    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ templateId: null, templateName: 'Standard', explanation: 'x' }),
        },
      ],
    });

    await suggestTemplate(longSegments, sampleTemplates);

    const userContent = mockCreate.mock.calls[0][0].messages[0].content as string;
    const parts = userContent.split('Transskription:\n');
    expect(parts).toHaveLength(2);
    const transcriptPart = parts[1].split('\n\nReturner JSON:')[0];
    expect(transcriptPart.length).toBeLessThanOrEqual(3000);
  });

  it('uses ephemeral cache_control on the system prompt', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ templateId: null, templateName: 'X', explanation: 'y' }),
        },
      ],
    });

    await suggestTemplate(sampleSegments, sampleTemplates);

    const system = mockCreate.mock.calls[0][0].system as Array<{ cache_control?: { type: string } }>;
    expect(system[0].cache_control?.type).toBe('ephemeral');
  });
});

// ─── generateMinutes ──────────────────────────────────────────────────────────

describe('generateMinutes', () => {
  beforeEach(() => mockCreate.mockReset());

  it('returns sections from Claude response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            sections: [
              { key: 'deltagere', label: 'Deltagere', content: '- Taler 1\n- Taler 2' },
              { key: 'beslutninger', label: 'Beslutninger', content: 'Ingen.' },
              { key: 'noter', label: 'Noter', content: '' },
            ],
          }),
        },
      ],
    });

    const result = await generateMinutes(sampleSegments, sampleSections);

    expect(result.sections).toHaveLength(3);
    expect(result.sections[0].key).toBe('deltagere');
    expect(result.sections[0].content).toBe('- Taler 1\n- Taler 2');
  });

  it('strips markdown code fences before parsing', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: '```json\n{"sections":[{"key":"k","label":"L","content":"C"}]}\n```',
        },
      ],
    });

    const result = await generateMinutes(sampleSegments, [
      { key: 'k', label: 'L', required: true },
    ]);
    expect(result.sections[0].content).toBe('C');
  });

  it('falls back to empty sections matching the template when JSON parse fails', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not valid json' }],
    });

    const result = await generateMinutes(sampleSegments, sampleSections);

    expect(result.sections).toHaveLength(sampleSections.length);
    result.sections.forEach((s) => expect(s.content).toBe(''));
    expect(result.sections.map((s) => s.key)).toEqual(sampleSections.map((s) => s.key));
  });

  it('throws when Claude returns non-text content', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'x', name: 'fn', input: {} }],
    });

    await expect(generateMinutes(sampleSegments, sampleSections)).rejects.toThrow(
      'Unexpected response from Claude',
    );
  });

  it('includes section keys and labels in the prompt', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ sections: [] }),
        },
      ],
    });

    await generateMinutes(sampleSegments, sampleSections);

    const userContent = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(userContent).toContain(JSON.stringify('deltagere'));
    expect(userContent).toContain(JSON.stringify('Deltagere'));
    expect(userContent).toContain(JSON.stringify('beslutninger'));
  });

  it('marks required sections as påkrævet in the prompt', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ sections: [] }) }],
    });

    await generateMinutes(sampleSegments, sampleSections);

    const userContent = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(userContent).toContain('påkrævet');
  });

  it('includes formatted timestamps in the transcript', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ sections: [] }) }],
    });

    await generateMinutes(
      [{ speaker: 'Taler 1', start: 65, end: 70, text: 'Hej' }],
      sampleSections,
    );

    const userContent = mockCreate.mock.calls[0][0].messages[0].content as string;
    // 65 seconds = 1:05
    expect(userContent).toContain('1:05');
  });

  it('uses ephemeral cache_control on the system prompt', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ sections: [] }) }],
    });

    await generateMinutes(sampleSegments, sampleSections);

    const system = mockCreate.mock.calls[0][0].system as Array<{ cache_control?: { type: string } }>;
    expect(system[0].cache_control?.type).toBe('ephemeral');
  });
});
