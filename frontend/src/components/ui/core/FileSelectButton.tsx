"use client";

import { LucideCheck, LucideLoaderCircle } from "lucide-react";

import { useStepper } from "@/components/custom/wizard/stepper";
import { Button } from "@/components/ui/core/shadcn/button";

import { Activity, type ChangeEvent, useRef, useState } from "react";

interface FileSelectButtonProps {
  fileType?: string;
}

/**
 *
 * **fileType**: Optional string to specify the accepted file type (e.g., "audio/*", "image/*").
 */
export const FileSelectButton = ({ fileType }: FileSelectButtonProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState<boolean>(false);

  const { setMetadata, metadata } = useStepper();
  const selectedFile = metadata["step-1"]?.["file"] as File | null;
  const isUploaded = metadata["step-1"]?.["isUploaded"] as boolean;

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const current = metadata["step-1"] ?? {};
      setMetadata("step-1", { ...current, file });
      console.log("Selected file:", file.name);
    }
  };

  const handleClick = () => {
    inputRef.current?.click();
  };

  // TODO: insert upload logic here (backend)
  const handleUpload = () => {
    setIsUploading(true);

    const fakeUploadTime = Math.random() * 2000 + 1500;

    window.setTimeout(() => {
      console.log("Finished uploading:", selectedFile?.name);
      setIsUploading(false);
      const current = metadata["step-1"] ?? {};
      setMetadata("step-1", { ...current, isUploaded: true });
    }, fakeUploadTime);
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <input
        ref={inputRef}
        type="file"
        accept={fileType}
        onChange={handleFileChange}
        className="hidden"
      />

      <Button
        variant="outline"
        onClick={handleClick}
        className={selectedFile?.name ? "text-gray-500" : ""}
      >
        {selectedFile?.name ? selectedFile?.name : "Vælg fil"}
      </Button>
      <Activity mode={selectedFile?.name ? "visible" : "hidden"}>
        <div className="flex flex-row gap-2 items-center">
          <Button onClick={handleUpload} disabled={isUploaded}>
            Upload
          </Button>

          {isUploading ? (
            <LucideLoaderCircle className="animate-spin" />
          ) : isUploaded ? (
            <LucideCheck className=" text-green-500" />
          ) : null}
        </div>
      </Activity>
    </div>
  );
};
