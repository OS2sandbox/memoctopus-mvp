import { defineStepper } from "@/components/ui/core/shadcn/stepper";

export enum Steps {
  UploadSpeechStep = "step-1",
  SelectPromptStep = "step-2",
  EditAndConfirmStep = "step-3",
  ShareStep = "step-4",
}

export const { Stepper, utils, useStepper } = defineStepper(
  {
    id: Steps.UploadSpeechStep,
    title: "Tilføj tale",
    description: "Optag eller upload tale",
  },
  {
    id: Steps.SelectPromptStep,
    title: "Vælg prompt",
    description: "Tilføj prompt og opsæt detaljer",
  },
  {
    id: Steps.EditAndConfirmStep,
    title: "Rediger og godkend",
    description: "Gennemgå og godkend indholdet",
  },
  {
    id: Steps.ShareStep,
    title: "Del",
    description: "Hvordan vil du dele teksten?",
  },
);
