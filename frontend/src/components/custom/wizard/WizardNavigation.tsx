import { type StepId, Stepper, useStepper, utils } from "./stepper";

export const WizardNavigation = () => {
  const { all, goTo, current, metadata } = useStepper();

  const canGoToStep = (targetId: StepId) => {
    const targetMeta = metadata[targetId];
    const currentHasBeenCompleted =
      utils.getNext(current.id).id === targetId &&
      metadata[current.id]?.["isCompleted"] === true;

    return targetMeta?.["isCompleted"] === true || currentHasBeenCompleted;
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
