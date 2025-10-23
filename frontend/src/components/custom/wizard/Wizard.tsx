import { Button } from "@/components/ui/core/shadcn/button";
import { defineStepper } from "@/components/ui/core/shadcn/stepper";

import { Fragment } from "react";

const { Stepper, utils } = defineStepper(
  { id: "step-1", title: "Step 1", description: "Description for step 1" },
  { id: "step-2", title: "Step 2", description: "Description for step 2" },
  { id: "step-3", title: "Step 3", description: "Description for step 3" },
  { id: "step-4", title: "Step 4", description: "Description for step 4" },
);

// TODO: Implement all steps content and navigation logic
export const Wizard = () => (
  <Stepper.Provider className="space-y-8 p-6 border rounded-lg bg-card shadow-sm w-full max-w-2xl mx-auto">
    {({ methods }) => (
      <Fragment>
        <div className={"text-center"}>
          <h2 className={"text-2xl font-semibold"}>Tale til tekst</h2>
          <p className="text-sm text-muted-foreground">
            Gennemgå hvert trin for at uploade, skrive prompt, godkende og dele.
          </p>
        </div>

        <Stepper.Navigation>
          {methods.all.map((step) => (
            <Stepper.Step
              key={step.id}
              of={step.id}
              onClick={() => methods.goTo(step.id)}
              className="flex flex-col items-center flex-1"
            >
              <div>{utils.getIndex(step.id) + 1}</div>
              <Stepper.Title>{step.title}</Stepper.Title>
            </Stepper.Step>
          ))}
        </Stepper.Navigation>

        {methods.switch({
          "step-1": () => (
            <Stepper.Panel className="p-6 rounded-md border bg-muted/20">
              <p>Panel of Step 1</p>
            </Stepper.Panel>
          ),
          "step-2": () => (
            <Stepper.Panel className="p-6 rounded-md border bg-muted/20">
              <p>Panel of Step 2</p>
            </Stepper.Panel>
          ),
          "step-3": () => (
            <Stepper.Panel className="p-6 rounded-md border bg-muted/20">
              <p>Panel of Step 3</p>
            </Stepper.Panel>
          ),
          "step-4": () => (
            <Stepper.Panel className="p-6 rounded-md border bg-muted/20">
              <p>Panel of Step 4</p>
            </Stepper.Panel>
          ),
        })}

        <Stepper.Controls className="flex justify-between">
          {!methods.isFirst && <Button onClick={methods.prev}>Tilbage</Button>}
          <Button onClick={methods.isLast ? methods.reset : methods.next}>
            {methods.isLast ? "Start forfra" : "Næste"}
          </Button>
        </Stepper.Controls>
      </Fragment>
    )}
  </Stepper.Provider>
);
