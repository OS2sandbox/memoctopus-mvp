export type MeetingStatus = 'joining' | 'recording' | 'processing' | 'review' | 'minutes' | 'done' | 'redacted' | 'failed';

export interface TranscriptSegment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface TemplateStructure {
  sections: TemplateSectionDef[];
}

export interface TemplateSectionDef {
  key: string;
  label: string;
  description?: string;
  required: boolean;
}

export interface MinutesContent {
  sections: MinutesSection[];
}

export interface MinutesSection {
  key: string;
  label: string;
  content: string;
}

export interface PiiReplacement {
  original: string;
  replacement: string;
  type: 'NAVN' | 'CPR' | 'ADRESSE' | 'TELEFON' | 'EMAIL' | 'OTHER' | 'ANDEN_PII';
  segmentIndex?: number;
}

export interface PiiResult {
  cleanedText: string;
  replacements: PiiReplacement[];
}

export interface TemplateSuggestion {
  templateId: string | null;
  templateName: string;
  explanation: string;
}

export interface Meeting {
  id: string;
  title: string;
  participants: string[];
  status: MeetingStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AudioFile {
  id: string;
  meetingId: string;
  filename: string;
  sizeBytes: number;
  durationSeconds: number | null;
  deletedAt: Date | null;
}

export interface Transcript {
  id: string;
  meetingId: string;
  rawText: string;
  segments: TranscriptSegment[];
  piiRemovedAt: Date | null;
}

export interface Minutes {
  id: string;
  meetingId: string;
  templateId: string | null;
  content: MinutesContent;
  version: number;
  createdAt: Date;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  structure: TemplateStructure;
  isDefault: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}
