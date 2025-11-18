export enum PROMPT_CATEGORY {
  Beslutningsreferat = "Beslutningsreferat",
  API = "API",
  ToDoListe = "Todo-liste",
  DetaljeretReferat = "Detaljeret referat",
  KortReferat = "Kort referat",

  // Formelle referater
  Moedereferat = "Mødereferat",
  Handlingsreferat = "Handlingsreferat", //  (to-do orienteret)
  Diskussionsreferat = "Diskussionsreferat", // (med centrale drøftelser og argumenter)

  // Uformelle eller korte opsamlinger
  Moedenoter = "Mødenoter", // (uformelt)
  Statusnotat = "Statusnotat", // (fx stand-up, teammøder)

  // Mødespecifikke referater
  ReferatFraBorgermoeder = "Referat fra borgermøder",
  ReferatFraMUSSamtaler = "Referat fra MUS-samtaler",
  DokumentationsorienteredeOpsamlinger = "Dokumentationsorienterede opsamlinger",
  Dokumentationsuddrag = "Dokumentationsuddrag", // (til udfyldelse af felter i et bestemt system)
}

export enum DATA_TABLE_SCOPE {
  MyItems = "my_items",
  MyOrganization = "my_organization",
  MyFavorites = "my_favorites",
}

export enum STEP_ID {
  UploadSpeechStep = "step-1",
  SelectPromptStep = "step-2",
  EditAndConfirmStep = "step-3",
  ShareStep = "step-4",
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

export const API_BASE_URL = process.env["NEXT_PUBLIC_API_URL"];
