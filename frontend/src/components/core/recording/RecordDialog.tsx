import { LucideMic, LucidePause, LucidePlay, LucideSquare } from "lucide-react";

import { Button } from "@/components/core/shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/core/shadcn/dialog";
import { StepId, useStepper } from "@/components/custom/wizard/stepper";
import { RecorderStatus, useRecorder } from "@/lib/hooks/use-recorder";
import { formatTime } from "@/lib/utils";

interface RecordDialogProps {
  isRecordingDisabled?: boolean;
}

/* TODO: Add recording functionality:
    - Implement wavesurfer library for audio visualization
    - Consider whether to use Wavesurfer MicrophonePlugin or not
 */

export const RecordDialog = ({
  isRecordingDisabled = false,
}: RecordDialogProps) => {
  const { setMetadata, metadata } = useStepper();

  const currentMetadata = metadata[StepId.UploadSpeechStep] ?? {};

  const {
    status,
    isRecording,
    url,
    time,
    error,
    audioLevel,

    start,
    pause,
    resume,
    stop,
    reset,
  } = useRecorder({
    autoSave: (file) =>
      setMetadata(StepId.UploadSpeechStep, { ...currentMetadata, file }),
  });

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size={"lg"} disabled={isRecordingDisabled}>
          <LucideMic /> Optag
        </Button>
      </DialogTrigger>

      <DialogContent className="flex flex-col items-center">
        <DialogHeader>
          <DialogTitle>Optag tale</DialogTitle>
        </DialogHeader>
        ew
        <div className="relative flex items-center justify-center">
          <div
            className="absolute rounded-full bg-muted transition-transform duration-75 ease-out"
            style={{
              width: "90px",
              height: "90px",
              transform: `scale(${audioLevel / 50})`,
              opacity: isRecording ? 0.7 : 0.3,
            }}
          />

          <LucideMic
            className={`relative h-10 w-10 ${
              isRecording ? "text-red-500" : "text-muted-foreground"
            } transition-colors duration-300`}
          />
        </div>
        <div className="text-sm text-muted-foreground">
          {status === RecorderStatus.Recording ||
          status === RecorderStatus.Paused
            ? `Tid: ${formatTime(time)}`
            : null}
        </div>
        <div className="flex gap-3">
          {status === RecorderStatus.Idle && (
            <Button onClick={start}>
              <LucidePlay className="mr-2 h-4 w-4" />
              Start
            </Button>
          )}

          {status === RecorderStatus.Recording && (
            <>
              <Button onClick={pause} variant="secondary">
                <LucidePause className="mr-2 h-4 w-4" />
                Pause
              </Button>
              <Button onClick={stop} variant="destructive">
                <LucideSquare className="mr-2 h-4 w-4" />
                Stop
              </Button>
            </>
          )}

          {status === RecorderStatus.Paused && (
            <>
              <Button onClick={resume}>
                <LucidePlay className="mr-2 h-4 w-4" />
                Fortsæt
              </Button>
              <Button onClick={stop} variant="destructive">
                <LucideSquare className="mr-2 h-4 w-4" />
                Stop
              </Button>
            </>
          )}

          {status === RecorderStatus.Stopped && (
            <>
              <Button onClick={reset} variant="outline">
                Ny optagelse
              </Button>
            </>
          )}
        </div>
        {url && status === RecorderStatus.Stopped && (
          <audio
            src={url}
            controls
            className="mt-4 w-full max-w-sm"
            preload="metadata"
          />
        )}
        {
          // TODO: Make a shadcn alert
          error && (
            <p className="text-sm text-destructive mt-4 text-center">{error}</p>
          )
        }
      </DialogContent>
    </Dialog>
  );
};
