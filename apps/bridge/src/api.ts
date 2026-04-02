import { buildPublicSubdomainHost, isDirectHost, isTryCloudflareHostname } from "@sinergy/shared";

function runtimeMatcherUrl() {
  const explicitUrl = import.meta.env.VITE_MATCHER_URL;
  if (explicitUrl) {
    return explicitUrl;
  }

  if (typeof window === "undefined") {
    return "http://127.0.0.1:8787";
  }

  const host = window.location.hostname;
  if (!host || host === "localhost" || host === "127.0.0.1") {
    return "http://127.0.0.1:8787";
  }

  if (isTryCloudflareHostname(host)) {
    return `${window.location.origin}/api`;
  }

  if (isDirectHost(host)) {
    return `${window.location.protocol}//${host}:8787`;
  }

  return `${window.location.protocol}//${buildPublicSubdomainHost(host, "api")}`;
}

const API_BASE = runtimeMatcherUrl();

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}
