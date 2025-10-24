import { EditAndConfirmStep } from "@/components/custom/wizard/steps/EditAndConfirmStep";
import { SelectPromptStep } from "@/components/custom/wizard/steps/SelectPromptStep";
import { ShareStep } from "@/components/custom/wizard/steps/ShareStep";
import { UploadSpeechStep } from "@/components/custom/wizard/steps/UploadSpeechStep";
import { WizardControls } from "@/components/custom/wizard/WizardControls";
import { WizardHeader } from "@/components/custom/wizard/WizardHeader";
import { WizardNavigation } from "@/components/custom/wizard/WizardNavigation";

import { Fragment } from "react";
import { Stepper } from "./stepper";

// TODO: Implement validation and conditional step navigation
export const Wizard = () => {
  return (
    <Stepper.Provider
      labelOrientation="vertical"
      className="space-y-8 p-6 border rounded-lg bg-card w-full max-w-5xl mx-auto"
      initialMetadata={{
        "step-1": {
          file: null as File | null,
          isUploaded: false,
        },
        "step-2": {},
        "step-3": {},
        "step-4": {},
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
              "step-1": () => <UploadSpeechStep />,
              "step-2": () => <SelectPromptStep />,
              "step-3": () => <EditAndConfirmStep />,
              "step-4": () => <ShareStep />,
            })
          }

          <WizardControls />
        </Fragment>
      )}
    </Stepper.Provider>
  );
};
