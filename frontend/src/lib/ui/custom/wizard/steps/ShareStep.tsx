import { STEP_ID } from "@/lib/constants";
import { Button } from "@/lib/ui/core/shadcn/button";
import { Input } from "@/lib/ui/core/shadcn/input";
import { ExportFormatDropdownMenu } from "@/lib/ui/custom/ExportFormatDropdownMenu";
import { useStepper } from "@/lib/ui/custom/wizard/stepper";
import { WizardContentPanel } from "@/lib/ui/custom/wizard/WizardContentPanel";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";
import { exportToPDF } from "@/lib/utils/utils";

import { useState } from "react";

interface HandleExportPDFProps {
  content: string;
  fileName: string;
}

const handleExportPDF = ({ content, fileName }: HandleExportPDFProps) => {
  exportToPDF({ html: content, fileName: fileName });
};

export const ShareStep = () => {
  const { metadata } = useStepper();
  const content: string =
    metadata[STEP_ID.EditAndConfirmStep]?.["editedSummary"];

  const [fileName, setFileName] = useState("");

  const handleFormatSelect = (format: string) => {
    console.log("Selected format:", format);
  };

  return (
    <WizardPanel>
      <WizardContentPanel className={"max-w-full"}>
        <Input
          placeholder={"Navngiv opsummering..."}
          onInput={(t) => setFileName(t.currentTarget.value)}
          value={fileName}
          className={"max-w-sm"}
        ></Input>
        <ExportFormatDropdownMenu onSelect={handleFormatSelect} />
        <Button
          onClick={() =>
            handleExportPDF({ content: content, fileName: fileName })
          }
        >
          PDF export test
        </Button>
      </WizardContentPanel>
    </WizardPanel>
  );
};
