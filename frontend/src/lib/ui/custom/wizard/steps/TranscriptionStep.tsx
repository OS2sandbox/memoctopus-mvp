import { STEP_ID } from "@/lib/constants";
import { MinimalTiptap } from "@/lib/ui/core/shadcn/minimal-tiptap";
import { useStepper } from "@/lib/ui/custom/wizard/stepper";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";
import { getVisibleTextLength } from "@/lib/utils/utils";

export const TranscriptionStep = () => {
  const { metadata, setMetadata } = useStepper();
  const stepMetadata = metadata[STEP_ID.TranscriptionStep] ?? {};
  const currentContent =
    stepMetadata["editedTranscription"] || stepMetadata["transcription"] || "";

  const handleChange = (content: string) => {
    const hasContent = getVisibleTextLength(content) > 0;
    setMetadata(STEP_ID.TranscriptionStep, {
      ...stepMetadata,
      editedTranscription: content,
      isCompleted: hasContent,
    });
  };

  return (
    <WizardPanel>
      <MinimalTiptap
        content={currentContent}
        onChange={handleChange}
        placeholder="Gennemgå og rediger transskriptionen..."
        editable={true}
      />
    </WizardPanel>
  );
};
