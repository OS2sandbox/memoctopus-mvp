import { Steps, useStepper } from "@/components/custom/wizard/stepper";
import { WizardContentPanel } from "@/components/custom/wizard/WizardContentPanel";
import { WizardPanel } from "@/components/custom/wizard/WizardPanel";
import { FileSelectButton } from "@/components/ui/core/FileSelectButton";
import { RecordDialog } from "@/components/ui/core/RecordDialog";
import { Button } from "@/components/ui/core/shadcn/button";
import { useWarnBeforeUnload } from "@/lib/hooks/use-warn-before-unload";

export const UploadSpeechStep = () => {
  const { metadata } = useStepper();
  const isUploaded = metadata[Steps.UploadSpeechStep]?.[
    "isUploaded"
  ] as boolean;

  useWarnBeforeUnload(isUploaded);

  return (
    <WizardPanel className="flex justify-center">
      <WizardContentPanel>
        <h2 className="text-lg font-semibold text-foreground">Optag tale</h2>
        <p className="text-sm text-muted-foreground">
          Du kan optage dit møde eller anden tale her på siden.
        </p>
        <RecordDialog isRecordingDisabled={isUploaded} />
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
        <Button disabled={isUploaded}>Find fil</Button>
      </WizardContentPanel>
    </WizardPanel>
  );
};
