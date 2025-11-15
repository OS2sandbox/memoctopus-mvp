import { useMutation } from "@tanstack/react-query";

import { transcribeAudio } from "@/lib/api/transcription";
import { STEP_ID } from "@/lib/constants";
import { useWarnBeforeUnload } from "@/lib/hooks/use-warn-before-unload";
import { Button } from "@/lib/ui/core/shadcn/button";
import { RecordDialog } from "@/lib/ui/custom/dialog/RecordDialog";
import { FileSelectButton } from "@/lib/ui/custom/FileSelectButton";
import { useStepper } from "@/lib/ui/custom/wizard/stepper";
import { WizardContentPanel } from "@/lib/ui/custom/wizard/WizardContentPanel";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export const UploadSpeechStep = () => {
  const router = useRouter();
  const { metadata, setMetadata, next } = useStepper();
  const uploadMetadata = metadata[STEP_ID.UploadSpeechStep] ?? {};
  const fileUploaded = uploadMetadata["isCompleted"] as boolean;
  const shouldTranscribe = uploadMetadata["shouldTranscribe"] as boolean;

  useWarnBeforeUnload(fileUploaded);

  const { mutate: transcribe, status: transcriptionStatus } = useMutation({
    mutationFn: ({ file }: { file: File }) => transcribeAudio({ file }),
    onSuccess: (transcription) => {
      setMetadata(STEP_ID.TranscriptionStep, {
        transcription: transcription.text,
        editedTranscription: transcription.text,
        isCompleted: false,
        isLoading: false,
      });
      setMetadata(STEP_ID.UploadSpeechStep, {
        ...uploadMetadata,
        shouldTranscribe: false,
      });
    },
    onError: () => {
      setMetadata(STEP_ID.TranscriptionStep, {
        transcription: "",
        editedTranscription: "",
        isCompleted: false,
        isLoading: false,
        error: true,
      });
    },
  });

  // When user clicks "Næste" in WizardControls, trigger transcription
  useEffect(() => {
    if (shouldTranscribe && uploadMetadata["file"]) {
      // Navigate to next step immediately and show loading state
      setMetadata(STEP_ID.TranscriptionStep, {
        transcription: "",
        editedTranscription: "",
        isCompleted: false,
        isLoading: true,
      });
      next();

      // Then start transcription
      transcribe({ file: uploadMetadata["file"] });
    }
  }, [shouldTranscribe]);

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
          Anvend din egen optagelse af et møde eller anden tale her.
        </p>
        <FileSelectButton fileType={"audio/*"} />
      </WizardContentPanel>
      <WizardContentPanel>
        <h2 className="text-lg font-semibold text-foreground">
          Tidligere sessioner
        </h2>
        <p className="text-sm text-muted-foreground">
          Hent opsummeringer og prompter fra tidligere sessioner.
        </p>
        <Button
          onClick={() => router.push("/app/history")}
          disabled={fileUploaded}
        >
          Find
        </Button>
      </WizardContentPanel>
    </WizardPanel>
  );
};
