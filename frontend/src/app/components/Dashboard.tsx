"use client";

import { useEffect, useState } from "react";
import { LogOut, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import FileUpload from "./FileUpload";
import { getErrorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import api from "@/lib/api";
import type { DownloadResponse, FileItem, FileListResponse } from "@/lib/types";

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    api
      .get<FileListResponse>("/files?limit=20")
      .then(({ data }) => {
        if (cancelled) return;
        setFiles(data.files);
        setNextCursor(data.nextCursor);
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
  }, []);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const { data } = await api.get<FileListResponse>(
        `/files?limit=20&cursor=${nextCursor}`,
      );
      setFiles((prev) => {
        const known = new Set(prev.map((f) => f.id));
        return [...prev, ...data.files.filter((f) => !known.has(f.id))];
      });
      setNextCursor(data.nextCursor);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleVisibility = async (file: FileItem) => {
    try {
      const { data } = await api.patch<FileItem>(`/files/${file.id}`, {
        visibility: file.visibility === "PUBLIC" ? "PRIVATE" : "PUBLIC",
      });
      setFiles((prev) => prev.map((f) => (f.id === data.id ? data : f)));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const handleDownload = async (file: FileItem) => {
    try {
      const { data } = await api.get<DownloadResponse>(
        `/files/${file.id}/download`,
      );
      window.open(data.downloadUrl, "_blank");
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const handleDelete = async (file: FileItem) => {
    if (!window.confirm(`Delete "${file.fileName}"? This cannot be undone.`)) {
      return;
    }
    try {
      await api.delete(`/files/${file.id}`);
      setFiles((prev) => prev.filter((f) => f.id !== file.id));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const copyShareLink = async (file: FileItem) => {
    const url = `${window.location.origin}/share/${file.id}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {}
  };

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            <ShieldCheck className="h-6 w-6 text-blue-600" />
            My Secure Files
          </h1>
          <p className="text-sm text-zinc-500">{user?.email}</p>
        </div>
        <button
          onClick={() => void logout()}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <LogOut className="h-4 w-4" />
          Log out
        </button>
      </header>

      <FileUpload
        onUploadSuccess={(file) => setFiles((prev) => [file, ...prev])}
        onError={setError}
      />

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="mt-8">
        <h2 className="mb-4 text-lg font-semibold text-zinc-800 dark:text-zinc-200">
          Your files
        </h2>

        {loading ? (
          <p className="text-sm text-zinc-500">Loading files…</p>
        ) : files.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No files yet. Upload your first file to get started.
          </p>
        ) : (
          <ul className="space-y-3">
            {files.map((file) => (
              <li
                key={file.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                    {file.fileName}
                  </p>
                  <p className="text-sm text-zinc-500">
                    {formatFileSize(file.fileSize)} ·{" "}
                    {file.mimeType || "Unknown type"}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={() => void toggleVisibility(file)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      file.visibility === "PUBLIC"
                        ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                        : "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
                    }`}
                    title={
                      file.visibility === "PUBLIC"
                        ? "Make private"
                        : "Make public"
                    }
                  >
                    {file.visibility === "PUBLIC" ? "Public" : "Private"}
                  </button>

                  <button
                    onClick={() => void handleDownload(file)}
                    className="text-sm font-medium text-blue-600 hover:underline"
                  >
                    Download
                  </button>

                  {file.visibility === "PUBLIC" && (
                    <Link
                      href={`/share/${file.id}`}
                      onClick={() => void copyShareLink(file)}
                      className="text-sm text-zinc-500 hover:underline"
                      title="Copy share link"
                    >
                      Copy Link
                    </Link>
                  )}

                  <button
                    onClick={() => void handleDelete(file)}
                    className="text-zinc-400 transition-colors hover:text-red-600"
                    title={`Delete ${file.fileName}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {nextCursor && !loading && (
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="mt-4 w-full rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {loadingMore ? "Loading more…" : "Load more files"}
          </button>
        )}
      </div>
    </div>
  );
}
