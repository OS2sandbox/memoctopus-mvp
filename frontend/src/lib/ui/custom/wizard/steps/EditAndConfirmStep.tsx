import { STEP_ID } from "@/lib/constants";
import { MinimalTiptap } from "@/lib/ui/core/shadcn/minimal-tiptap";
import { useStepper } from "@/lib/ui/custom/wizard/stepper";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";
import { getVisibleTextLength, handleSafeFileName } from "@/lib/utils/utils";

export const EditAndConfirmStep = () => {
  const { metadata, setMetadata } = useStepper();
  const editConfirmMetadata = metadata[STEP_ID.EditAndConfirmStep] ?? {};
  const currentContent =
    editConfirmMetadata["editedSummary"] ||
    editConfirmMetadata["summary"] ||
    "";

  const handleChange = (content: string) => {
    const hasContent = getVisibleTextLength(content) > 0;
    setMetadata(STEP_ID.EditAndConfirmStep, {
      ...editConfirmMetadata,
      editedSummary: content,
      isCompleted: hasContent,
      title: handleSafeFileName({ fileName: undefined }),
    });
  };

  return (
    <WizardPanel>
      <MinimalTiptap
        content={currentContent}
        onChange={handleChange}
        placeholder="Gennemgå og rediger referatet..."
        editable={true}
      />
    </WizardPanel>
  );
};
