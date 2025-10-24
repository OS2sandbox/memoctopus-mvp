import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { Stepper } from "./stepper";

interface WizardPanelProps {
  children: ReactNode;
  className?: string;
}

export const WizardPanel = ({ children, className }: WizardPanelProps) => (
  <Stepper.Panel className={cn("p-6 rounded-md border bg-muted/20", className)}>
    {children}
  </Stepper.Panel>
);
