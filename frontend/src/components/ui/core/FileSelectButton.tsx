"use client";

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
  const [fileName, setFileName] = useState<string | null>(null);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setFileName(file.name);
      console.log("Selected file:", file);
    }
  };

  const handleClick = () => {
    inputRef.current?.click();
  };

  // TODO: insert upload logic here (backend)
  const handleUpload = () => {
    return console.log("Uploading file:", fileName);
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
        className={fileName ? "text-gray-500" : ""}
      >
        {fileName ? fileName : "Vælg fil"}
      </Button>

      <Activity mode={fileName ? "visible" : "hidden"}>
        <Button onClick={handleUpload}>Upload</Button>
      </Activity>
    </div>
  );
};
