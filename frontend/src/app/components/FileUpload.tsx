"use client";

import { useState, type ChangeEvent } from "react";
import axios from "axios";
import api, { getErrorMessage } from "@/lib/api";
import type {
  FileItem,
  MultipartPart,
  MultipartPartUrlResponse,
  MultipartStartResponse,
  RequestUploadResponse,
} from "@/lib/types";
import { UploadCloud } from "lucide-react";

const SINGLE_PUT_MAX_SIZE = 100 * 1024 * 1024;
const MULTIPART_MAX_SIZE = 5 * 1024 * 1024 * 1024;

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const uploadSinglePut = async (
  file: File,
  fileType: string,
  onProgress: (percent: number) => void,
): Promise<FileItem> => {
  const { data: upload } = await api.post<RequestUploadResponse>(
    "/files/upload-url",
    {
      fileName: file.name,
      fileType,
      fileSize: file.size,
    },
  );

  await axios.put(upload.uploadUrl, file, {
    headers: { "Content-Type": fileType },
    onUploadProgress: (progressEvent) => {
      if (progressEvent.total) {
        const percent = Math.round(
          (progressEvent.loaded * 100) / progressEvent.total,
        );
        onProgress(Math.min(percent, 100));
      }
    },
  });

  const { data: created } = await api.post<FileItem>("/files", {
    fileName: file.name,
    s3Key: upload.s3Key,
    fileSize: file.size,
    mimeType: fileType,
  });

  return created;
};

const uploadMultipart = async (
  file: File,
  fileType: string,
  onProgress: (percent: number) => void,
): Promise<FileItem> => {
  const { data: start } = await api.post<MultipartStartResponse>(
    "/files/multipart/start",
    {
      fileName: file.name,
      fileType,
      fileSize: file.size,
    },
  );

  const parts: MultipartPart[] = [];
  let uploadedBytes = 0;

  for (let partNumber = 1; partNumber <= start.partCount; partNumber++) {
    const startByte = (partNumber - 1) * start.partSize;
    const endByte = Math.min(startByte + start.partSize, file.size);
    const chunk = file.slice(startByte, endByte);

    const { data: part } = await api.post<MultipartPartUrlResponse>(
      "/files/multipart/part-url",
      {
        uploadId: start.uploadId,
        s3Key: start.s3Key,
        partNumber,
      },
    );

    const response = await axios.put(part.partUrl, chunk, {
      headers: { "Content-Type": fileType },
    });

    const etag = response.headers.etag;
    if (!etag) {
      // Without a readable ETag the upload cannot be completed; failing
      // loudly here beats an opaque "all parts must be uploaded" error at
      // completion time. Missing ETag almost always means the bucket CORS
      // config does not expose it.
      throw new Error(
        `Storage did not return an ETag for part ${partNumber}. ` +
          "The bucket CORS configuration must expose the ETag header.",
      );
    }
    parts.push({ PartNumber: partNumber, ETag: etag });
    uploadedBytes += chunk.size;
    onProgress(
      Math.min(Math.round((uploadedBytes * 100) / file.size), 100),
    );
  }

  const { data: created } = await api.post<FileItem>(
    "/files/multipart/complete",
    {
      uploadId: start.uploadId,
      s3Key: start.s3Key,
      parts,
    },
  );

  return created;
};

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

    if (file.size > MULTIPART_MAX_SIZE) {
      onError("File exceeds the 5 GB upload limit.");
      return;
    }

    setUploading(true);
    setProgress(0);
    setFileName(file.name);
    onError("");

    try {
      const fileType = file.type || "application/octet-stream";
      const created =
        file.size > SINGLE_PUT_MAX_SIZE
          ? await uploadMultipart(file, fileType, setProgress)
          : await uploadSinglePut(file, fileType, setProgress);

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
          Maximum file size: {formatFileSize(MULTIPART_MAX_SIZE)} (multipart for
          large files)
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
