import { SummaryEditor } from "@/components/custom/editor/SummaryEditor";
import { StepId, useStepper } from "@/components/custom/wizard/stepper";
import { WizardPanel } from "@/components/custom/wizard/WizardPanel";

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
