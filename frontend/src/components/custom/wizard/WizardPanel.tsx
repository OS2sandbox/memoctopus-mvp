import type { ReactNode } from "react";

import { Stepper } from "./stepper";

interface WizardPanelProps {
  children: ReactNode;
}

export const WizardPanel = ({ children }: WizardPanelProps) => (
  <Stepper.Panel className="p-6 rounded-md border bg-muted/20">
    {children}
  </Stepper.Panel>
);
