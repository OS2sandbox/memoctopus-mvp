import { FileSelectButton } from "@/components/core/FileSelectButton";
import { RecordDialog } from "@/components/core/recording/RecordDialog";
import { Button } from "@/components/core/shadcn/button";
import { StepId, useStepper } from "@/components/custom/wizard/stepper";
import { WizardContentPanel } from "@/components/custom/wizard/WizardContentPanel";
import { WizardPanel } from "@/components/custom/wizard/WizardPanel";
import { useWarnBeforeUnload } from "@/lib/hooks/use-warn-before-unload";

export const UploadSpeechStep = () => {
  const { metadata } = useStepper();
  const fileUploaded = metadata[StepId.UploadSpeechStep]?.[
    "isCompleted"
  ] as boolean;

  useWarnBeforeUnload(fileUploaded);

  return (
    <WizardPanel className="flex justify-center">
      <WizardContentPanel>
        <h2 className="text-lg font-semibold text-foreground">Optag tale</h2>
        <p className="text-sm text-muted-foreground">
          Du kan optage dit møde eller anden tale her på siden.
        </p>
        <RecordDialog isRecordingDisabled={fileUploaded} />
      </WizardContentPanel>
      <WizardContentPanel>
        <h2 className="text-lg font-semibold text-foreground">Upload tale</h2>
        <p className="text-sm text-muted-foreground">
          Upload din egen optagelse af et møde eller anden tale her.
        </p>
        <FileSelectButton fileType={"audio/*"} />
      </WizardContentPanel>
      <WizardContentPanel>
        <h2 className="text-lg font-semibold text-foreground">Genbrug tale</h2>
        <p className="text-sm text-muted-foreground">
          Dine optagelser og uploads ligger i systemet i en uge, så du altid kan
          lave en opsummering.
        </p>
        <Button disabled={fileUploaded}>Find fil</Button>
      </WizardContentPanel>
    </WizardPanel>
  );
};
