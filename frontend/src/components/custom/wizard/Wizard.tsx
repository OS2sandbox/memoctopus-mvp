import { WizardHeader } from "@/components/custom/wizard/WizardHeader";
import { Button } from "@/components/ui/core/shadcn/button";

import { Fragment } from "react";
import { Stepper } from "./stepper";
import { WizardPanel } from "./WizardPanel";

// TODO: Implement all steps content and navigation logic
export const Wizard = () => {
  return (
    <Stepper.Provider
      labelOrientation="vertical"
      className="space-y-8 p-6 border rounded-lg bg-card w-full max-w-2xl mx-auto"
    >
      {({ methods }) => (
        <Fragment>
          <WizardHeader infoText={methods.current.description} />

          <Stepper.Navigation>
            {methods.all.map((step) => (
              <Stepper.Step
                key={step.id}
                of={step.id}
                onClick={() => methods.goTo(step.id)}
                className="flex flex-col items-center flex-1 text-center"
              >
                <Stepper.Title>{step.title}</Stepper.Title>
              </Stepper.Step>
            ))}
          </Stepper.Navigation>

          {methods.switch({
            "step-1": () => (
              <WizardPanel>
                <p>{methods.current.description}</p>
              </WizardPanel>
            ),
            "step-2": () => (
              <Stepper.Panel className="p-6 rounded-md border bg-muted/20">
                <p>{methods.current.description}</p>
              </Stepper.Panel>
            ),
            "step-3": () => (
              <Stepper.Panel className="p-6 rounded-md border bg-muted/20">
                <p>{methods.current.description}</p>
              </Stepper.Panel>
            ),
            "step-4": () => (
              <Stepper.Panel className="p-6 rounded-md border bg-muted/20">
                <p>{methods.current.description}</p>
              </Stepper.Panel>
            ),
          })}

          <Stepper.Controls className="flex justify-between">
            {!methods.isFirst && (
              <Button onClick={methods.prev}>Tilbage</Button>
            )}
            <Button onClick={methods.isLast ? methods.reset : methods.next}>
              {methods.isLast ? "Start forfra" : "Næste"}
            </Button>
          </Stepper.Controls>
        </Fragment>
      )}
    </Stepper.Provider>
  );
};
