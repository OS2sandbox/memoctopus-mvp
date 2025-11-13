import {
  LucideAlertCircle,
  LucideMic,
  LucidePause,
  LucidePlay,
  LucideSquare,
} from "lucide-react";

import { RECORDER_STATUS, STEP_ID } from "@/lib/constants";
import { useRecorder } from "@/lib/hooks/use-recorder";
import { Alert, AlertTitle } from "@/lib/ui/core/shadcn/alert";
import { Button } from "@/lib/ui/core/shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/lib/ui/core/shadcn/dialog";
import { useStepper } from "@/lib/ui/custom/wizard/stepper";
import { formatTime } from "@/lib/utils/utils";

import { Activity, Fragment, useState } from "react";

interface RecordDialogProps {
  isRecordingDisabled?: boolean;
}

export const RecordDialog = ({
  isRecordingDisabled = false,
}: RecordDialogProps) => {
  const { setMetadata, metadata } = useStepper();
  const [open, setOpen] = useState(false);

  const currentMetadata = metadata[STEP_ID.UploadSpeechStep] ?? {};
  const handleAutoSave = (file: File) => {
    setMetadata(STEP_ID.UploadSpeechStep, {
      ...currentMetadata,
      file,
      isCompleted: file,
    });
  };

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
    autoSave: (file) => handleAutoSave(file),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size={"lg"} disabled={isRecordingDisabled}>
          <LucideMic /> Optag
        </Button>
      </DialogTrigger>

      <DialogContent className="flex flex-col items-center">
        <DialogHeader>
          <DialogTitle>Optag tale</DialogTitle>
        </DialogHeader>
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
          {status === RECORDER_STATUS.Recording ||
          status === RECORDER_STATUS.Paused
            ? `Tid: ${formatTime(time)}`
            : null}
        </div>
        <div className="flex gap-3">
          {status === RECORDER_STATUS.Idle && (
            <Button onClick={start}>
              <LucidePlay className="mr-2 h-4 w-4" />
              Start
            </Button>
          )}

          {status === RECORDER_STATUS.Recording && (
            <Fragment>
              <Button onClick={pause} variant="secondary">
                <LucidePause className="mr-2 h-4 w-4" />
                Pause
              </Button>
              <Button onClick={stop} variant="destructive">
                <LucideSquare className="mr-2 h-4 w-4" />
                Stop
              </Button>
            </Fragment>
          )}

          {status === RECORDER_STATUS.Paused && (
            <Fragment>
              <Button onClick={resume}>
                <LucidePlay className="mr-2 h-4 w-4" />
                Fortsæt
              </Button>
              <Button onClick={stop} variant="destructive">
                <LucideSquare className="mr-2 h-4 w-4" />
                Stop
              </Button>
            </Fragment>
          )}

          {status === RECORDER_STATUS.Stopped && (
            <Fragment>
              <Button onClick={reset} variant="outline">
                Ny optagelse
              </Button>
              <Button onClick={() => setOpen(false)}>Anvend</Button>
            </Fragment>
          )}
        </div>
        {url && status === RECORDER_STATUS.Stopped && (
          <audio
            src={url}
            controls
            className="mt-4 w-full max-w-sm"
            preload="metadata"
          />
        )}
        <Activity mode={error ? "visible" : "hidden"}>
          <Alert variant="destructive">
            <LucideAlertCircle />
            <AlertTitle>{error}</AlertTitle>
          </Alert>
        </Activity>
      </DialogContent>
    </Dialog>
  );
};
