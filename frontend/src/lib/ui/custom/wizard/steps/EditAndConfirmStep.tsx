import { SummaryEditor } from "@/lib/ui/custom/editor/SummaryEditor";
import { StepId, useStepper } from "@/lib/ui/custom/wizard/stepper";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";

export const EditAndConfirmStep = () => {
  const { metadata, setMetadata } = useStepper();
  const currentMetadata = metadata[StepId.EditAndConfirmStep] ?? {};

  return (
    <WizardPanel>
      <SummaryEditor
        onApprove={(content) => {
          setMetadata(StepId.EditAndConfirmStep, {
            ...currentMetadata,
            isCompleted: true,
            transcript: content,
          });
        }}
        initialContent={currentMetadata["transcript"]}
      />
    </WizardPanel>
  );
};
