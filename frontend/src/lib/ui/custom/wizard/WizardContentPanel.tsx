import type { ReactNode } from "react";

import { cn } from "@/lib/utils/utils";

interface WizardContentPanelProps {
  children: ReactNode;
  className?: string;
}

export const WizardContentPanel = ({
  children,
  className,
}: WizardContentPanelProps) => {
  return (
    <div
      className={cn(
        "flex flex-col p-5 border items-start rounded-lg bg-card w-full max-w-2xl mx-2 space-y-3",
        className,
      )}
    >
      {children}
    </div>
  );
};
