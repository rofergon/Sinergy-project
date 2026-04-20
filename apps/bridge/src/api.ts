import { buildPublicSubdomainHost, isDirectHost, isTryCloudflareHostname } from "@sinergy/shared";
import { clearAuthSession, ensureAuthenticated } from "./auth";

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

type ApiRequestInit = RequestInit & {
  authAddress?: string;
};

export async function api<T>(path: string, init?: ApiRequestInit): Promise<T> {
  async function performRequest(allowRetry: boolean): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    if (init?.authAddress) {
      const token = await ensureAuthenticated(API_BASE, init.authAddress);
      headers.set("Authorization", `Bearer ${token}`);
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
    });

    if (response.status === 401 && init?.authAddress && allowRetry) {
      clearAuthSession(init.authAddress);
      return performRequest(false);
    }

    return response;
  }

  const response = await performRequest(true);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}
