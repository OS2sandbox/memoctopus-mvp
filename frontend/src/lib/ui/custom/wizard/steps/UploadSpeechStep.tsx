import { STEP_ID } from "@/lib/constants";
import { useWarnBeforeUnload } from "@/lib/hooks/use-warn-before-unload";
import { Button } from "@/lib/ui/core/shadcn/button";
import { FileSelectButton } from "@/lib/ui/custom/FileSelectButton";
import { RecordDialog } from "@/lib/ui/custom/recording/RecordDialog";
import { useStepper } from "@/lib/ui/custom/wizard/stepper";
import { WizardContentPanel } from "@/lib/ui/custom/wizard/WizardContentPanel";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";

export const UploadSpeechStep = () => {
  const { metadata } = useStepper();
  const fileUploaded = metadata[STEP_ID.UploadSpeechStep]?.[
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
