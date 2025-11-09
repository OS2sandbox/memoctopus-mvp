import { STEP_ID } from "@/lib/constants";
import { SummaryEditor } from "@/lib/ui/custom/editor/SummaryEditor";
import { useStepper } from "@/lib/ui/custom/wizard/stepper";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";

export const EditAndConfirmStep = () => {
  const { metadata, setMetadata } = useStepper();
  const editConfirmMetadata = metadata[STEP_ID.EditAndConfirmStep] ?? {};

  return (
    <WizardPanel>
      <SummaryEditor
        onApprove={(content) => {
          setMetadata(STEP_ID.EditAndConfirmStep, {
            ...editConfirmMetadata,
            isCompleted: content && content.length > 0,
            editedSummary: content,
          });
        }}
        initialContent={editConfirmMetadata["summary"]}
      />
    </WizardPanel>
  );
};
