// Must match backend PromptCategory enum exactly
export const PROMPT_CATEGORY = [
  "Beslutningsreferat",
  "API",
  "To do liste",
  "Detaljeret referat",
  "Kort referat",
] as const;

export type PromptCategory = (typeof PROMPT_CATEGORY)[number];

export enum DATA_TABLE_SCOPE {
  MyItems = "my_items",
  MyOrganization = "my_organization",
  MyFavorites = "my_favorites",
}

export enum STEP_ID {
  UploadSpeechStep = "step-1",
  TranscriptionStep = "step-2",
  SelectPromptStep = "step-3",
  EditAndConfirmStep = "step-4",
  ShareStep = "step-5",
}

export enum EXPORT_FORMAT {
  PDF = "pdf",
  DOCX = "docx",
}

export enum AUTH_MODE {
  SignUp,
  SignIn,
}

export enum RECORDER_STATUS {
  Idle = "idle",
  Recording = "recording",
  Stopped = "stopped",
  Paused = "paused",
  Error = "error",
}

export enum HISTORY_ENTRY_KIND {
  PROMPT = "prompt",
  TRANSCRIPT = "transcript",
}

export const MIN_TRANSCRIPT_LENGTH = 1;
export const MAX_TRANSCRIPT_LENGTH = 5000;

export const MIN_PROMPT_LENGTH = 10;
export const MAX_PROMPT_LENGTH = 4000;

export const MIN_ASSET_NAME_LENGTH = 1;
export const MAX_ASSET_NAME_LENGTH = 100;

// Empty to use relative URLs - each API file specifies the correct path
export const API_BASE_URL = "";
