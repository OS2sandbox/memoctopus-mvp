import { STEP_ID } from "@/lib/constants";
import { defineStepper } from "@/lib/ui/core/shadcn/stepper";

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
    id: STEP_ID.TranscriptionStep,
    title: "Transkriberet",
    description: "Gennemgå og rediger transskriptionen",
  },
  {
    id: STEP_ID.SelectPromptStep,
    title: "Skabelon",
    description: "Tilføj skabelon og opsæt detaljer",
  },
  {
    id: STEP_ID.EditAndConfirmStep,
    title: "Referat",
    description: "Gennemgå og godkend opsummeringen",
  },
  {
    id: STEP_ID.ShareStep,
    title: "Del",
    description: "Hvordan vil du dele teksten?",
  },
);
