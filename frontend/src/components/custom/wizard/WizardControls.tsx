import { Stepper, useStepper } from "@/components/custom/wizard/stepper";
import { Button } from "@/components/ui/core/shadcn/button";

import { Activity } from "react";

export const WizardControls = () => {
  const { isFirst, prev, isLast, reset, next, metadata } = useStepper();
  const isUploaded = metadata["step-1"]?.["isUploaded"] as boolean;

  return (
    <Stepper.Controls className="flex justify-between items-center mt-6">
      <div className="min-w-[120px]">
        <Activity mode={!isFirst ? "visible" : "hidden"}>
          <Button onClick={prev}>Tilbage</Button>
        </Activity>
      </div>

      <div className="min-w-[120px] text-right">
        <Button disabled={isUploaded} onClick={isLast ? reset : next}>
          {isLast ? "Start forfra" : "Næste"}
        </Button>
      </div>
    </Stepper.Controls>
  );
};
