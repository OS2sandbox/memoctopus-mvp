export enum PROMPT_CATEGORY {
  Beslutningsreferat = "Beslutningsreferat",
  API = "API",
  ToDoListe = "To do liste",
  DetaljeretReferat = "Detaljeret referat",
  KortReferat = "Kort referat",
}

export enum FILTER_MODE {
  Mine = "onlyMine",
  Favorites = "onlyFavorites",
}

export enum DATA_TABLE_SCOPE {
  MyItems = "my_items",
  MyOrganization = "my_organization",
}

export enum STEP_ID {
  UploadSpeechStep = "step-1",
  SelectPromptStep = "step-2",
  EditAndConfirmStep = "step-3",
  ShareStep = "step-4",
}
