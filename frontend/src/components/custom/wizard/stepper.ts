import { defineStepper } from "@/components/ui/core/shadcn/stepper";

export enum StepId {
  UploadSpeechStep = "step-1",
  SelectPromptStep = "step-2",
  EditAndConfirmStep = "step-3",
  ShareStep = "step-4",
}

// TODO: isCompleted should be set for all steps (to false initially)
export const defaultMetadata = {
  file: null as File | null,
  isCompleted: true,
};

export const { Stepper, utils, useStepper } = defineStepper(
  {
    id: StepId.UploadSpeechStep,
    title: "Tilføj tale",
    description: "Optag eller upload tale",
  },
  {
    id: StepId.SelectPromptStep,
    title: "Vælg prompt",
    description: "Tilføj prompt og opsæt detaljer",
  },
  {
    id: StepId.EditAndConfirmStep,
    title: "Rediger og godkend",
    description: "Gennemgå og godkend indholdet",
  },
  {
    id: StepId.ShareStep,
    title: "Del",
    description: "Hvordan vil du dele teksten?",
  },
);
