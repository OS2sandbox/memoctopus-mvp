import { STEP_ID } from "@/lib/constants";
import type { Prompt } from "@/lib/schemas/prompt";
import { EditAndConfirmStep } from "@/lib/ui/custom/wizard/steps/EditAndConfirmStep";
import { SelectPromptStep } from "@/lib/ui/custom/wizard/steps/SelectPromptStep";
import { ShareStep } from "@/lib/ui/custom/wizard/steps/ShareStep";
import { TranscriptionStep } from "@/lib/ui/custom/wizard/steps/TranscriptionStep";
import { UploadSpeechStep } from "@/lib/ui/custom/wizard/steps/UploadSpeechStep";
import { WizardControls } from "@/lib/ui/custom/wizard/WizardControls";
import { WizardHeader } from "@/lib/ui/custom/wizard/WizardHeader";
import { WizardNavigation } from "@/lib/ui/custom/wizard/WizardNavigation";

import { Fragment } from "react";
import { defaultMetadata, Stepper } from "./stepper";

interface WizardProps {
  initialTranscription?: string | undefined;
  startAtSelectPrompt?: boolean | undefined;
}

// TODO: Fragment metadata into a separate file; metadata.ts for example
export const Wizard = ({
  initialTranscription,
  startAtSelectPrompt,
}: WizardProps) => {
  const providerProps = {
    labelOrientation: "vertical" as const,
    className:
      "space-y-8 p-6 border rounded-lg bg-card w-full max-w-5xl mx-auto",
    ...(startAtSelectPrompt && { initialStep: STEP_ID.SelectPromptStep }),
  };

  return (
    <Stepper.Provider
      {...providerProps}
      initialMetadata={{
        [STEP_ID.UploadSpeechStep]: {
          ...defaultMetadata,
          file: null as File | null,
          isCompleted: !!initialTranscription,
        },
        [STEP_ID.TranscriptionStep]: {
          ...defaultMetadata,
          transcription: initialTranscription ?? "",
          editedTranscription: initialTranscription ?? "",
          isCompleted: !!initialTranscription,
        },
        [STEP_ID.SelectPromptStep]: {
          ...defaultMetadata,
          prompt: null as Prompt | null,
        },
        [STEP_ID.EditAndConfirmStep]: {
          ...defaultMetadata,
          editedSummary: "",
          title: "",
        },
        [STEP_ID.ShareStep]: {
          ...defaultMetadata,
          title: "",
        },
      }}
    >
      {({ methods }) => (
        <Fragment>
          <WizardHeader
            title={methods.current.title}
            infoText={methods.current.description}
          />

          <WizardNavigation />

          {
            // TODO: Make a factory for step panels
            methods.switch({
              [STEP_ID.UploadSpeechStep]: () => <UploadSpeechStep />,
              [STEP_ID.TranscriptionStep]: () => <TranscriptionStep />,
              [STEP_ID.SelectPromptStep]: () => <SelectPromptStep />,
              [STEP_ID.EditAndConfirmStep]: () => <EditAndConfirmStep />,
              [STEP_ID.ShareStep]: () => <ShareStep />,
            })
          }

          <WizardControls />
        </Fragment>
      )}
    </Stepper.Provider>
  );
};
