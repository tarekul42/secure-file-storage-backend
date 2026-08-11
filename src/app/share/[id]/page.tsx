"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Download, FileIcon, Lock } from "lucide-react";
import api, { getErrorMessage } from "@/lib/api";
import type { DownloadResponse } from "@/lib/types";

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export default function SharePage() {
  const params = useParams<{ id: string }>();
  const fileId = params.id as string;

  const [share, setShare] = useState<DownloadResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fileId) return;
    let cancelled = false;

    api
      .get<DownloadResponse>(`/files/${fileId}/share`)
      .then(({ data }) => {
        if (!cancelled) setShare(data);
      })
      .catch((err) => {
        if (!cancelled) setError(getErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fileId]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-zinc-400">
        Loading…
      </div>
    );
  }

  if (error || !share) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <Lock className="mx-auto h-10 w-10 text-zinc-400" />
          <h1 className="mt-4 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            {error ?? "File unavailable"}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            This file may have been removed or made private by its owner.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-blue-50 dark:bg-blue-950">
          <FileIcon className="h-7 w-7 text-blue-600" />
        </div>
        <h1 className="mt-4 break-words text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          {share.fileName}
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          {formatFileSize(share.fileSize)} · {share.mimeType || "Unknown type"}
        </p>
        <a
          href={share.downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white transition-colors hover:bg-blue-700"
        >
          <Download className="h-4 w-4" />
          Download file
        </a>
        <p className="mt-4 text-xs text-zinc-400">
          Download link expires in 5 minutes.
        </p>
      </div>
    </div>
  );
}