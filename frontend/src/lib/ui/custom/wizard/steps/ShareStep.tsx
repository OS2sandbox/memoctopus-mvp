import { EXPORT_FORMAT, STEP_ID } from "@/lib/constants";
import { useWarnBeforeUnload } from "@/lib/hooks/use-warn-before-unload";
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
import { exportToPdf } from "@/lib/utils/export/exportToPdf";
import { handleSafeFileName } from "@/lib/utils/utils";

import { useState } from "react";

export const ShareStep = () => {
  useWarnBeforeUnload(true);

  const { metadata, setMetadata, current } = useStepper();
  const currentMetadata = metadata[current.id];
  const content: string = currentMetadata?.["editedTranscript"];

  const [exportedFormat, setExportedFormat] = useState(EXPORT_FORMAT.PDF);

  const defaultFileName = handleSafeFileName({});
  const title = currentMetadata?.["title"]?.trim() ?? "";
  const finalFileName =
    title.length > 0
      ? handleSafeFileName({ fileName: title })
      : defaultFileName;

  const exportFormatHandler = () => {
    switch (exportedFormat) {
      case EXPORT_FORMAT.PDF: {
        return exportToPdf({ content: content, fileName: finalFileName });
      }
      case EXPORT_FORMAT.DOCX: {
        return exportToDocx({ content: content, fileName: finalFileName });
      }
    }
  };

  const handleOnInput = (val: string) => {
    setMetadata(STEP_ID.ShareStep, {
      title: val,
    });
  };

  return (
    <WizardPanel>
      <WizardContentPanel className={"mx-auto gap-2"}>
        <FieldSet>
          <FieldLegend>Eksportér opsummering</FieldLegend>

          <Field orientation="vertical">
            <FieldLabel htmlFor="fileName">Filnavn</FieldLabel>
            <FieldContent>
              <Input
                id="fileName"
                placeholder={defaultFileName}
                value={title}
                onInput={(e) => handleOnInput(e.currentTarget.value)}
              />
              <FieldDescription>
                Hvis filnavn udeladt, bruges nuværende data og tid som filnavn.
              </FieldDescription>
            </FieldContent>
          </Field>

          <Field orientation="vertical" className="w-20">
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
          Eksportér
        </Button>
      </WizardContentPanel>
    </WizardPanel>
  );
};
