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
  SelectPromptStep = "step-2",
  EditAndConfirmStep = "step-3",
  ShareStep = "step-4",
}

export enum EXPORT_FORMAT {
  PDF = "PDF",
  DOCX = "DOCX",
  EMAIL = "Email",
}
