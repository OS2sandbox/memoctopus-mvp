import { PromptTable } from "@/components/custom/prompt-library/table/PromptTable";
import { WizardContentPanel } from "@/components/custom/wizard/WizardContentPanel";
import { WizardPanel } from "@/components/custom/wizard/WizardPanel";

export const SelectPromptStep = () => {
  return (
    <WizardPanel>
      <WizardContentPanel>
        <PromptTable />
      </WizardContentPanel>
    </WizardPanel>
  );
};
