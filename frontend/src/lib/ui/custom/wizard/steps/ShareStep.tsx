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

import { useState } from "react";

export const ShareStep = () => {
  useWarnBeforeUnload(true);

  const { metadata, setMetadata, current } = useStepper();
  const currentMetadata = metadata[current.id];
  const content: string = currentMetadata?.["editedTranscript"];

  const defaultTitle = metadata[STEP_ID.EditAndConfirmStep]?.["title"];
  const [titleInput, setTitleInput] = useState("");

  const [exportedFormat, setExportedFormat] = useState(EXPORT_FORMAT.PDF);

  const exportHandlers = {
    [EXPORT_FORMAT.PDF]: exportToPdf,
    [EXPORT_FORMAT.DOCX]: exportToDocx,
  } as const;

  const exportFormatHandler = () => {
    try {
      const finalTitle =
        titleInput.trim().length > 0 ? titleInput : defaultTitle;
      const exportHandler = exportHandlers[exportedFormat];

      if (!exportHandler) {
        throw new Error(`export format not supported: ${exportedFormat}`);
      }

      setMetadata(STEP_ID.ShareStep, {
        title: finalTitle,
      });

      return exportHandler({
        content,
        fileName: finalTitle,
      });
    } catch (error) {
      console.error("Error during export:", error);
    }
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
                placeholder={defaultTitle}
                value={titleInput}
                onInput={(e) => setTitleInput(e.currentTarget.value)}
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
