import type { ReactNode } from "react";

interface WizardContentPanelProps {
  children: ReactNode;
}

export const WizardContentPanel = ({ children }: WizardContentPanelProps) => {
  return (
    <div
      className={
        "flex flex-col p-5 border items-start rounded-lg bg-card w-full max-w-2xl mx-2 space-y-3"
      }
    >
      {children}
    </div>
  );
};
