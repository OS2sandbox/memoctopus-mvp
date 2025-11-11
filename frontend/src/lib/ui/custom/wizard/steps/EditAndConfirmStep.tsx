import { STEP_ID } from "@/lib/constants";
import { SummaryEditor } from "@/lib/ui/custom/editor/SummaryEditor";
import { useStepper } from "@/lib/ui/custom/wizard/stepper";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";
import { handleSafeFileName } from "@/lib/utils/utils";

export const EditAndConfirmStep = () => {
  const { metadata, setMetadata, next } = useStepper();
  const editConfirmMetadata = metadata[STEP_ID.EditAndConfirmStep] ?? {};
  const isCompleted = editConfirmMetadata["isCompleted"] as boolean;

  return (
    <WizardPanel>
      <SummaryEditor
        disabled={isCompleted}
        onApprove={(content) => {
          setMetadata(STEP_ID.EditAndConfirmStep, {
            ...editConfirmMetadata,
            isCompleted: content && content.length > 0,
            editedSummary: content,
            title: handleSafeFileName({ fileName: undefined }),
          });
          next();
        }}
        initialContent={editConfirmMetadata["summary"]}
      />
    </WizardPanel>
  );
};
