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
  // The referat as a single flowing markdown document. This is the canonical
  // representation; the editor renders one borderless surface over it.
  body?: string;
  // Legacy section-based representation, kept so older saved minutes still load.
  // `minutesToBody()` (src/lib/minutes-format.ts) flattens these into `body`.
  sections?: MinutesSection[];
  // Editable document header rendered above the body in both the editor preview
  // and the export, so the two read one-to-one. `date` is only populated when the
  // "Dato" tag is selected at generation (otherwise the meeting date would appear
  // both here and inside the body); a null date means no date line is shown.
  header?: MinutesHeader;
}

export interface MinutesHeader {
  title: string;
  date: string | null;
}

export interface MinutesSection {
  key: string;
  label: string;
  content: string;
}

// A reusable, shareable prompt for generating a referat. The free-text `prompt`
// drives generation; the include* flags optionally inject the matching category
// (Deltagere / Beslutningspunkter / Dagsorden / Dato) into the output.
export interface Skabelon {
  id: string;
  name: string;
  description: string;
  prompt: string;
  includeDeltagere: boolean;
  includeBeslutningspunkter: boolean;
  includeDagsorden: boolean;
  includeDato: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
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
