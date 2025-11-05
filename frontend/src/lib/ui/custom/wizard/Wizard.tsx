import { EditAndConfirmStep } from "@/lib/ui/custom/wizard/steps/EditAndConfirmStep";
import { SelectPromptStep } from "@/lib/ui/custom/wizard/steps/SelectPromptStep";
import { ShareStep } from "@/lib/ui/custom/wizard/steps/ShareStep";
import { UploadSpeechStep } from "@/lib/ui/custom/wizard/steps/UploadSpeechStep";
import { WizardControls } from "@/lib/ui/custom/wizard/WizardControls";
import { WizardHeader } from "@/lib/ui/custom/wizard/WizardHeader";
import { WizardNavigation } from "@/lib/ui/custom/wizard/WizardNavigation";

import { Fragment } from "react";
import { defaultMetadata, StepId, Stepper } from "./stepper";

// TODO: Fragment metadata into a separate file; metadata.ts for example
export const Wizard = () => {
  return (
    <Stepper.Provider
      labelOrientation="vertical"
      className="space-y-8 p-6 border rounded-lg bg-card w-full max-w-5xl mx-auto"
      initialMetadata={{
        [StepId.UploadSpeechStep]: {
          ...defaultMetadata,
          isCompleted: false,
        },
        [StepId.SelectPromptStep]: {
          ...defaultMetadata,
        },
        [StepId.EditAndConfirmStep]: {
          ...defaultMetadata,
          isCompleted: false,
          transcript: "",
        },
        [StepId.ShareStep]: {
          ...defaultMetadata,
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
              [StepId.UploadSpeechStep]: () => <UploadSpeechStep />,
              [StepId.SelectPromptStep]: () => <SelectPromptStep />,
              [StepId.EditAndConfirmStep]: () => <EditAndConfirmStep />,
              [StepId.ShareStep]: () => <ShareStep />,
            })
          }

          <WizardControls />
        </Fragment>
      )}
    </Stepper.Provider>
  );
};
