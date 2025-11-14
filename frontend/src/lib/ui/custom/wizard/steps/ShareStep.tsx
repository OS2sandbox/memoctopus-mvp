import { useMutation } from "@tanstack/react-query";

import { downloadExport, type ExportRequest } from "@/lib/api/export";
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
import { Spinner } from "@/lib/ui/core/shadcn/spinner";
import { ExportFormatSelect } from "@/lib/ui/custom/ExportFormatSelect";
import { useStepper } from "@/lib/ui/custom/wizard/stepper";
import { WizardContentPanel } from "@/lib/ui/custom/wizard/WizardContentPanel";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";

import { useState } from "react";

export const ShareStep = () => {
  useWarnBeforeUnload(true);

  const { metadata, setMetadata } = useStepper();
  const content: string =
    metadata[STEP_ID.EditAndConfirmStep]?.["editedSummary"];

  const defaultTitle = metadata[STEP_ID.EditAndConfirmStep]?.["title"];
  const [titleInput, setTitleInput] = useState("");

  const [exportedFormat, setExportedFormat] = useState(EXPORT_FORMAT.PDF);

  const exportMutation = useMutation({
    mutationFn: async ({ format, markdown, fileName = "" }: ExportRequest) =>
      downloadExport({ format, markdown, fileName }),
  });

  const exportFormatHandler = () => {
    try {
      const finalTitle =
        titleInput.trim().length > 0 ? titleInput : defaultTitle;

      setMetadata(STEP_ID.ShareStep, {
        title: finalTitle,
        isCompleted: true,
      });

      if (!content) {
        new Error("No content to export");
      }

      exportMutation.mutate({
        format: exportedFormat,
        markdown: content.trim(),
        fileName: finalTitle.trim(),
      });
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <WizardPanel>
      <WizardContentPanel className={"mx-auto gap-2"}>
        <FieldSet>
          <FieldLegend>Eksportér opsummering</FieldLegend>

          <Field orientation="vertical">
            <FieldLabel>Filnavn</FieldLabel>
            <FieldContent>
              <Input
                id="fileName"
                placeholder={defaultTitle}
                value={titleInput}
                onInput={(e) => setTitleInput(e.currentTarget.value)}
              />
              <FieldDescription>
                Hvis filnavn udeladt, anvendes nuværende dato filnavn og titel I
                historik.
              </FieldDescription>
            </FieldContent>
          </Field>

          <Field orientation="vertical" className="w-20">
            <FieldLabel>Format</FieldLabel>
            <FieldContent>
              <ExportFormatSelect
                selected={exportedFormat}
                onSelect={setExportedFormat}
              />
            </FieldContent>
          </Field>
        </FieldSet>
        <Separator />
        <Button className="self-end" onClick={() => exportFormatHandler()}>
          {exportMutation.isPending ? <Spinner /> : "Eksportér"}
        </Button>
      </WizardContentPanel>
    </WizardPanel>
  );
};
