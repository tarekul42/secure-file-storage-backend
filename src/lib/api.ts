import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import type { ApiErrorResponse, RefreshTokenResponse } from "./types";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api",
});

export const ACCESS_TOKEN_KEY = "token";
export const REFRESH_TOKEN_KEY = "refreshToken";

// Endpoints whose own 401s must never trigger (or loop through) a refresh.
const AUTH_EXEMPT_PATHS = [
  "/auth/login",
  "/auth/register",
  "/auth/refresh",
  "/auth/logout",
];

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(ACCESS_TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

interface RetryableConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

let refreshPromise: Promise<string> | null = null;

const refreshAccessToken = async (): Promise<string> => {
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    throw new Error("No refresh token available");
  }

  // Raw axios instance: must not go through this api's interceptors.
  const { data } = await axios.post<RefreshTokenResponse>(
    `${api.defaults.baseURL}/auth/refresh`,
    { refreshToken },
  );

  localStorage.setItem(ACCESS_TOKEN_KEY, data.token);
  localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
  return data.token;
};

const clearSession = (): void => {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
};

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiErrorResponse>) => {
    const config = error.config as RetryableConfig | undefined;
    const status = error.response?.status;

    if (
      !config ||
      status !== 401 ||
      config._retry ||
      AUTH_EXEMPT_PATHS.some((path) => (config.url ?? "").includes(path))
    ) {
      return Promise.reject(error);
    }

    config._retry = true;

    try {
      // Single in-flight refresh; concurrent 401s queue behind it and all
      // retry with the same rotated access token.
      refreshPromise ??= refreshAccessToken().finally(() => {
        refreshPromise = null;
      });
      const token = await refreshPromise;

      config.headers.Authorization = `Bearer ${token}`;
      return api(config);
    } catch {
      clearSession();
      if (typeof window !== "undefined") {
        window.location.replace("/login");
      }
      return Promise.reject(error);
    }
  },
);

export const getErrorMessage = (error: unknown): string => {
  if (axios.isAxiosError<ApiErrorResponse>(error)) {
    const body = error.response?.data;
    if (body?.errors?.length) {
      return body.errors[0]?.message ?? body.message;
    }
    if (body?.message) return body.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Please try again.";
};

export default api;
