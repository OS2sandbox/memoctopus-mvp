import { NextRequest, NextResponse } from 'next/server';
import { suggestTemplate, generateMinutes, generateMinutesFreeform } from '@/lib/ai/minutes';
import { getTemplates } from '@/lib/storage/templates';
import { TranscriptSegment, TemplateStructure } from '@/types';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { segments, customPrompt, participants } = body as {
    segments: TranscriptSegment[];
    customPrompt?: string;
    participants?: string[];
  };

  if (!segments || segments.length === 0) {
    return NextResponse.json({ error: 'No segments provided' }, { status: 400 });
  }

  const templates = getTemplates();
  let minutesContent;
  let templateId: string | null = null;

  if (customPrompt) {
    minutesContent = await generateMinutesFreeform(segments, customPrompt, participants);
  } else {
    const suggestion = await suggestTemplate(
      segments,
      templates.map((t) => ({ id: t.id, name: t.name, description: t.description })),
    );

    const chosenTemplate =
      templates.find((t) => t.id === suggestion.templateId) ??
      templates.find((t) => t.isDefault) ??
      templates[0];

    if (!chosenTemplate) {
      return NextResponse.json({ error: 'No templates available' }, { status: 500 });
    }

    templateId = chosenTemplate.id;
    minutesContent = await generateMinutes(
      segments,
      (chosenTemplate.structure as TemplateStructure).sections,
      undefined,
      participants,
    );
  }

  return NextResponse.json({ content: minutesContent, templateId });
}
