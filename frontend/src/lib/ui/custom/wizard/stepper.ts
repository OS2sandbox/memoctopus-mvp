import { STEP_ID } from "@/lib/constants";
import { defineStepper } from "@/lib/ui/core/shadcn/stepper";

// TODO: isCompleted should be set for all steps (to false initially)
export const defaultMetadata = {
  file: null as File | null,
  isCompleted: true,
};

export const { Stepper, utils, useStepper } = defineStepper(
  {
    id: STEP_ID.UploadSpeechStep,
    title: "Tilføj tale",
    description: "Optag eller upload tale",
  },
  {
    id: STEP_ID.SelectPromptStep,
    title: "Vælg prompt",
    description: "Tilføj prompt og opsæt detaljer",
  },
  {
    id: STEP_ID.EditAndConfirmStep,
    title: "Rediger og godkend",
    description: "Gennemgå og godkend indholdet",
  },
  {
    id: STEP_ID.ShareStep,
    title: "Del",
    description: "Hvordan vil du dele teksten?",
  },
);
