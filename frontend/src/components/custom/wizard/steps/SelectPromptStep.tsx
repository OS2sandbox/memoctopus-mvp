import { WizardContentPanel } from "@/components/custom/wizard/WizardContentPanel";
import { WizardPanel } from "@/components/custom/wizard/WizardPanel";
import { RecordDialog } from "@/components/ui/core/RecordDialog";

export const SelectPromptStep = () => {
  return (
    <WizardPanel>
      <WizardContentPanel>
        <h2 className="text-lg font-semibold text-foreground">Vælg Prompt</h2>
        <RecordDialog />
        this is text
      </WizardContentPanel>
    </WizardPanel>
  );
};
