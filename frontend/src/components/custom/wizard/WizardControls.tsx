import { LucideTrash } from "lucide-react";

import { Button } from "@/components/core/shadcn/button";
import {
  StepId,
  Stepper,
  useStepper,
} from "@/components/custom/wizard/stepper";

import { Activity } from "react";

export const WizardControls = () => {
  const { isFirst, prev, isLast, reset, next, metadata, current, setMetadata } =
    useStepper();
  const isCompleted = metadata[current.id]?.["isCompleted"] as boolean;
  const currentFile = metadata[current.id]?.["file"] as boolean;

  return (
    <Stepper.Controls className="flex justify-between items-center mt-6">
      <div className="min-w-[120px]">
        <Activity mode={!isFirst ? "visible" : "hidden"}>
          <Button onClick={prev}>Tilbage</Button>
        </Activity>
      </div>

      <div className="min-w-[120px] text-right flex gap-2 justify-end">
        <Activity mode={currentFile ? "visible" : "hidden"}>
          <Button
            variant="destructive"
            onClick={() =>
              setMetadata(StepId.UploadSpeechStep, {
                file: null,
                isCompleted: false,
              })
            }
          >
            <LucideTrash />
            Fjern valgt fil
          </Button>
        </Activity>

        <Button disabled={!isCompleted} onClick={isLast ? reset : next}>
          {isLast ? "Start forfra" : "Næste"}
        </Button>
      </div>
    </Stepper.Controls>
  );
};
