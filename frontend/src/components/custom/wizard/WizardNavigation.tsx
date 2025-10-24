import { Stepper, useStepper } from "./stepper";

export const WizardNavigation = () => {
  const { all, goTo } = useStepper();

  return (
    <Stepper.Navigation>
      {all.map((step) => (
        <Stepper.Step
          key={step.id}
          of={step.id}
          onClick={() => goTo(step.id)}
          className="flex flex-col items-center flex-1 text-center"
        >
          <Stepper.Title>{step.title}</Stepper.Title>
        </Stepper.Step>
      ))}
    </Stepper.Navigation>
  );
};
