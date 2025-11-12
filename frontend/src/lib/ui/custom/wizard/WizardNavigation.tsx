import type { STEP_ID } from "@/lib/constants";

import { Stepper, useStepper, utils } from "./stepper";

export const WizardNavigation = () => {
  const { all, goTo, current, metadata } = useStepper();

  const canGoToStep = (targetId: STEP_ID) => {
    const isCurrentCompleted: boolean = metadata[current.id]?.["isCompleted"];
    const isGoingForward =
      all.findIndex((s) => s.id === targetId) >
      all.findIndex((s) => s.id === current.id);

    if (isGoingForward && !isCurrentCompleted) {
      return false;
    }

    const target = metadata[targetId];
    const currentHasBeenCompleted =
      utils.getNext(current.id).id === targetId && isCurrentCompleted;

    const result = target?.["isCompleted"] || currentHasBeenCompleted;

    return result;
  };

  return (
    <Stepper.Navigation>
      {all.map((step) => (
        <Stepper.Step
          key={step.id}
          of={step.id}
          onClick={() => canGoToStep(step.id) && goTo(step.id)}
          className="flex flex-col items-center flex-1 text-center"
        >
          <Stepper.Title>{step.title}</Stepper.Title>
        </Stepper.Step>
      ))}
    </Stepper.Navigation>
  );
};
