import { defineStepper } from "@stepperize/react";

import { Button } from "@/components/ui/core/shadcn/button";

import { Fragment } from "react";

const WizardStepper = defineStepper(
  { id: "step-1", title: "Step 1", description: "Description for step 1" },
  { id: "step-2", title: "Step 2", description: "Description for step 2" },
  { id: "step-3", title: "Step 3", description: "Description for step 3" },
  { id: "step-4", title: "Step 4", description: "Description for step 4" },
);

// TODO: Implement all steps content and navigation logic
export const Wizard = () => (
  <WizardStepper.Scoped>
    <StepContent />
    <StepActions />
  </WizardStepper.Scoped>
);

const StepContent = () => {
  const { when } = WizardStepper.useStepper();
  return (
    <Fragment>
      {when("step-1", (step) => (
        <p>Starting with {step.title}</p>
      ))}
      {when("step-2", (step) => (
        <p>In the middle: {step.title}</p>
      ))}
      {when("step-3", (step) => (
        <p>Starting with {step.title}</p>
      ))}
      {when("step-4", (step) => (
        <p>Starting with {step.title}</p>
      ))}
    </Fragment>
  );
};

const StepActions = () => {
  const stepper = WizardStepper.useStepper();

  return !stepper.isLast ? (
    <div className="flex items-center gap-2">
      <Button onClick={stepper.prev} disabled={stepper.isFirst}>
        Previous
      </Button>

      <Button onClick={stepper.next}>
        {stepper.when(
          "step-4",
          () => "Finish",
          () => "Next",
        )}
      </Button>
    </div>
  ) : (
    <div className="flex items-center gap-2">
      <Button onClick={stepper.reset}>Reset</Button>
    </div>
  );
};
/*
const StepNavigation = () => {
  const { isLast, reset, next, when } = WizardStepper.useStepper();
  return (
    <button onClick={isLast ? reset : next}>
      {when(
        "step-4",
        () => "Reset",
        () => "Next",
      )}
    </button>
  );
};
 */
