import { LucideTrash } from "lucide-react";

import { STEP_ID } from "@/lib/constants";
import { Button } from "@/lib/ui/core/shadcn/button";
import { Stepper, useStepper } from "@/lib/ui/custom/wizard/stepper";

import { Activity } from "react";

export const WizardControls = () => {
  const {
    isFirst,
    prev,
    isLast,
    reset,
    next,
    metadata,
    current,
    setMetadata,
    resetMetadata,
  } = useStepper();
  const isCompleted = metadata[current.id]?.["isCompleted"] as boolean;
  const currentFile = metadata[current.id]?.["file"] as boolean;
  const isFirstStep = current.id === STEP_ID.UploadSpeechStep;

  const onNextClick = () => {
    if (isLast) {
      reset();
      resetMetadata(true);
    } else {
      next();
    }
  };

  return (
    <Stepper.Controls className="flex justify-between items-center mt-6">
      <div className="min-w-[120px]">
        <Activity mode={!isFirst ? "visible" : "hidden"}>
          <Button onClick={prev}>Tilbage</Button>
        </Activity>
      </div>

      <div className="min-w-[120px] text-right flex gap-2 justify-end">
        <Activity mode={currentFile && isFirstStep ? "visible" : "hidden"}>
          <Button
            variant="destructive"
            onClick={() =>
              setMetadata(STEP_ID.UploadSpeechStep, {
                file: null,
                isCompleted: false,
              })
            }
          >
            <LucideTrash />
            Fjern valgt fil
          </Button>
        </Activity>

        <Activity
          mode={
            current.id === STEP_ID.EditAndConfirmStep && !isCompleted
              ? "hidden"
              : "visible"
          }
        >
          <Button disabled={!isLast && !isCompleted} onClick={onNextClick}>
            {isLast ? "Start forfra" : "Næste"}
          </Button>
        </Activity>
      </div>
    </Stepper.Controls>
  );
};
