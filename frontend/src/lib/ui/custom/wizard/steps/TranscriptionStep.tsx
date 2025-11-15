import { STEP_ID } from "@/lib/constants";
import { Spinner } from "@/lib/ui/core/shadcn/spinner";
import { TranscriptionEditor } from "@/lib/ui/custom/editor/TranscriptionEditor";
import { useStepper } from "@/lib/ui/custom/wizard/stepper";
import { WizardPanel } from "@/lib/ui/custom/wizard/WizardPanel";

export const TranscriptionStep = () => {
  const { metadata, setMetadata, next } = useStepper();
  const transcriptionMetadata = metadata[STEP_ID.TranscriptionStep] ?? {};
  const isCompleted = transcriptionMetadata["isCompleted"] as boolean;
  const isLoading = transcriptionMetadata["isLoading"] as boolean;
  const hasError = transcriptionMetadata["error"] as boolean;

  if (isLoading) {
    return (
      <WizardPanel>
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-4 border rounded-lg bg-muted/50">
            <Spinner className="size-5" />
            <span className="text-sm text-muted-foreground">
              Transskriberer din lydfil...
            </span>
          </div>
          {/* Skeleton loading animation */}
          <div className="space-y-3 animate-pulse">
            <div className="h-4 bg-muted rounded w-full" />
            <div className="h-4 bg-muted rounded w-11/12" />
            <div className="h-4 bg-muted rounded w-10/12" />
            <div className="h-4 bg-muted rounded w-full" />
            <div className="h-4 bg-muted rounded w-9/12" />
            <div className="h-4 bg-muted rounded w-11/12" />
            <div className="h-4 bg-muted rounded w-10/12" />
            <div className="h-4 bg-muted rounded w-full" />
          </div>
        </div>
      </WizardPanel>
    );
  }

  if (hasError) {
    return (
      <WizardPanel>
        <div className="p-4 border border-destructive rounded-lg bg-destructive/10">
          <p className="text-destructive font-medium">
            Der opstod en fejl ved transskribering af din lydfil.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Prøv venligst igen.
          </p>
        </div>
      </WizardPanel>
    );
  }

  return (
    <WizardPanel>
      <TranscriptionEditor
        disabled={isCompleted}
        onApprove={(content) => {
          setMetadata(STEP_ID.TranscriptionStep, {
            ...transcriptionMetadata,
            isCompleted: content && content.length > 0,
            editedTranscription: content,
          });
          next();
        }}
        initialContent={transcriptionMetadata["transcription"]}
      />
    </WizardPanel>
  );
};
