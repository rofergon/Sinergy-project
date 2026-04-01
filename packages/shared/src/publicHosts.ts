const PUBLIC_SUBDOMAIN_PREFIXES = new Set([
  "app",
  "bridge",
  "api",
  "rpc",
  "ws",
  "rest",
  "tm",
  "indexer",
]);

export function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function isIpv4Hostname(hostname: string) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

export function isDirectHost(hostname: string) {
  return isLoopbackHostname(hostname) || isIpv4Hostname(hostname);
}

export function isTryCloudflareHostname(hostname: string) {
  return hostname.endsWith(".trycloudflare.com");
}

export function derivePublicBaseHost(hostname: string) {
  if (!hostname || isDirectHost(hostname)) {
    return hostname;
  }

  const labels = hostname.split(".");
  if (labels.length < 2) {
    return hostname;
  }

  if (PUBLIC_SUBDOMAIN_PREFIXES.has(labels[0])) {
    return labels.slice(1).join(".");
  }

  return hostname;
}

export function buildPublicSubdomainHost(hostname: string, subdomain: string) {
  if (!hostname || isDirectHost(hostname)) {
    return hostname;
  }

  const baseHost = derivePublicBaseHost(hostname);
  return `${subdomain}.${baseHost}`;
}
