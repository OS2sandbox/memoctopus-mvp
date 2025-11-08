import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";
import {exportToPDF} from "@/lib/utils/utils";
import {useStepper} from "@/lib/ui/custom/wizard/stepper";
import {STEP_ID} from "@/lib/constants";
import {Button} from "@/lib/ui/core/shadcn/button";

interface HandleExportPDFProps {
    content: string;
}

const handleExportPDF = ({ content }: HandleExportPDFProps) => {
    exportToPDF({ html: content })
}

export const ShareStep = () => {
    const { metadata } = useStepper();
    const content = metadata[STEP_ID.EditAndConfirmStep]?.["editedSummary"]

    console.log("ShareStep content:", content);

  return (
      <WizardPanel>
          <Button
              onClick={() => handleExportPDF({ content: content })}>
              PDF export test
          </Button>
      </WizardPanel>
  );
};
