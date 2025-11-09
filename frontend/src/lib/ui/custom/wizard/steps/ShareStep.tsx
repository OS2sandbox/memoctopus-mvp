import { EXPORT_FORMAT, STEP_ID } from "@/lib/constants";
import { Button } from "@/lib/ui/core/shadcn/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/lib/ui/core/shadcn/field";
import { Input } from "@/lib/ui/core/shadcn/input";
import { Separator } from "@/lib/ui/core/shadcn/separator";
import { FormatDropdownMenu } from "@/lib/ui/custom/ExportFormatDropdownMenu";
import { useStepper } from "@/lib/ui/custom/wizard/stepper";
import { WizardContentPanel } from "@/lib/ui/custom/wizard/WizardContentPanel";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";
import { exportToDocx } from "@/lib/utils/export/exportToDocx";
import {
  exportToPdf,
  handleSafeFileName,
} from "@/lib/utils/export/exportToPdf";

import { useState } from "react";

export const ShareStep = () => {
  const { metadata } = useStepper();
  const content: string =
    metadata[STEP_ID.EditAndConfirmStep]?.["editedSummary"];

  const [fileName, setFileName] = useState("");
  const [exportedFormat, setExportedFormat] = useState(EXPORT_FORMAT.PDF);

  const exportFormatHandler = () => {
    switch (exportedFormat) {
      case EXPORT_FORMAT.PDF: {
        return exportToPdf({ html: content, fileName: fileName });
      }
      case EXPORT_FORMAT.DOCX: {
        return exportToDocx({ html: content, fileName: fileName });
      }
    }
  };

  return (
    <WizardPanel className="items-center">
      <WizardContentPanel className={"mx-auto gap-2"}>
        <FieldSet className="mb-3">
          <FieldLegend>Eksportér opsummering</FieldLegend>

          <Field orientation="vertical">
            <FieldLabel htmlFor="fileName">Filnavn</FieldLabel>
            <FieldContent>
              <Input
                id="fileName"
                placeholder={handleSafeFileName({ fileName: undefined })}
                value={fileName}
                onInput={(e) => setFileName(e.currentTarget.value)}
              />
              <FieldDescription>
                Hvis filnavn udeladt, bruges nuværende data og tid som filnavn.
              </FieldDescription>
            </FieldContent>
          </Field>

          <Field orientation="vertical" className="w-24">
            <FieldLabel htmlFor="exportFormat">Format</FieldLabel>
            <FieldContent>
              <FormatDropdownMenu
                selected={exportedFormat}
                onSelect={setExportedFormat}
              />
            </FieldContent>
          </Field>
        </FieldSet>
        <Separator />
        <Button className="self-end" onClick={() => exportFormatHandler()}>
          Eksporter
        </Button>
      </WizardContentPanel>
    </WizardPanel>
  );
};
