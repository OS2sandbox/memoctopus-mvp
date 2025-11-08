import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";
import {exportToPDF} from "@/lib/utils/utils";
import {useStepper} from "@/lib/ui/custom/wizard/stepper";
import {STEP_ID} from "@/lib/constants";
import {Button} from "@/lib/ui/core/shadcn/button";
import {Prompt} from "@/lib/schemas/prompt";

interface HandleExportPDFProps {
    content: string;
    fileName: string;
}

const handleExportPDF = ({ content, fileName }: HandleExportPDFProps) => {
    exportToPDF({ html: content, fileName: fileName })
}

export const ShareStep = () => {
    const { metadata } = useStepper();
    const content: string = metadata[STEP_ID.EditAndConfirmStep]?.["editedSummary"];
    const prompt: Prompt = metadata[STEP_ID.SelectPromptStep]?.["prompt"];

  return (
      <WizardPanel>
          <Button
              onClick={() => handleExportPDF({ content: content, fileName: prompt.name })}>
              PDF export test
          </Button>
      </WizardPanel>
  );
};
