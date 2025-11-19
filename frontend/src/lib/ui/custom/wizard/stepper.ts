import { STEP_ID } from "@/lib/constants";
import { defineStepper } from "@/lib/ui/core/shadcn/stepper";

// TODO: isCompleted should be set for all steps (to false initially)
export const defaultMetadata = {
  file: null as File | null,
  isCompleted: false,
};

export const { Stepper, utils, useStepper } = defineStepper(
  {
    id: STEP_ID.UploadSpeechStep,
    title: "Samtale",
    description: "Vælg om du vil optage, uploade eller genbruge en samtale",
  },
  {
    id: STEP_ID.SelectPromptStep,
    title: "Prompt",
    description: "Tilføj prompt og opsæt detaljer",
  },
  {
    id: STEP_ID.EditAndConfirmStep,
    title: "Redigér",
    description: "Gennemgå og godkend opsummeringen",
  },
  {
    id: STEP_ID.ShareStep,
    title: "Del",
    description: "Hvordan vil du dele teksten?",
  },
);
