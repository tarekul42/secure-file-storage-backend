"use client";

import { useState, type ChangeEvent } from "react";
import axios from "axios";
import api, { getErrorMessage } from "@/lib/api";
import type { FileItem, RequestUploadResponse } from "@/lib/types";
import { UploadCloud } from "lucide-react";

const MAX_FILE_SIZE = 100 * 1024 * 1024;

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export default function FileUpload({
  onUploadSuccess,
  onError,
}: {
  onUploadSuccess: (file: FileItem) => void;
  onError: (message: string) => void;
}) {
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
      onError("File exceeds the 100 MB upload limit.");
      return;
    }

    setUploading(true);
    setProgress(0);
    setFileName(file.name);
    onError("");

    try {
      const { data: upload } = await api.post<RequestUploadResponse>(
        "/files/upload-url",
        {
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
        },
      );

      await axios.put(upload.uploadUrl, file, {
        headers: { "Content-Type": file.type },
        onUploadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const percent = Math.round(
              (progressEvent.loaded * 100) / progressEvent.total,
            );
            setProgress(Math.min(percent, 100));
          }
        },
      });

      const { data: created } = await api.post<FileItem>("/files", {
        fileName: file.name,
        s3Key: upload.s3Key,
        fileSize: file.size,
        mimeType: file.type,
      });

      onUploadSuccess(created);
    } catch (err) {
      onError(getErrorMessage(err));
    } finally {
      setUploading(false);
      setProgress(0);
      setFileName(null);
    }
  };

  return (
    <div className="border-2 border-dashed border-zinc-300 rounded-lg p-6 text-center dark:border-zinc-700">
      <input
        type="file"
        onChange={handleFileUpload}
        className="hidden"
        id="file-upload"
        disabled={uploading}
      />
      <label
        htmlFor="file-upload"
        className="cursor-pointer flex flex-col items-center gap-1"
      >
        <UploadCloud className="h-10 w-10 text-zinc-400" />
        <span className="font-medium text-blue-600">
          {uploading ? "Uploading…" : "Click to upload"}
        </span>
        <span className="text-sm text-zinc-500">
          Maximum file size: {formatFileSize(MAX_FILE_SIZE)}
        </span>
      </label>

      {uploading && (
        <div className="mt-4">
          <p className="mb-1 truncate text-sm text-zinc-500">{fileName}</p>
          <div className="h-2.5 w-full rounded-full bg-zinc-200 dark:bg-zinc-700">
            <div
              className="h-2.5 rounded-full bg-blue-600 transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-1 text-sm text-zinc-500">{progress}%</p>
        </div>
      )}
    </div>
  );
}
