export enum PROMPT_CATEGORY {
  Beslutningsreferat = "Beslutningsreferat",
  API = "API",
  ToDoListe = "To do liste",
  DetaljeretReferat = "Detaljeret referat",
  KortReferat = "Kort referat",
}

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
