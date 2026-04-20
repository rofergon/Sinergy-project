type SignMessageFn = (args: { message: string }) => Promise<`0x${string}`>;

type StoredSession = {
  token: string;
  expiresAt: string;
};

let signMessageFn: SignMessageFn | undefined;
const inflightSessions = new Map<string, Promise<string>>();

function normalizeAddress(address: string) {
  return address.toLowerCase();
}

function sessionKey(address: string) {
  return `sinergy.matcher.auth.${normalizeAddress(address)}`;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function readStoredSession(address: string): StoredSession | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const raw = window.localStorage.getItem(sessionKey(address));
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    window.localStorage.removeItem(sessionKey(address));
    return undefined;
  }
}

function writeStoredSession(address: string, session: StoredSession) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(sessionKey(address), JSON.stringify(session));
}

function isSessionValid(session: StoredSession) {
  return Date.parse(session.expiresAt) - Date.now() > 30_000;
}

async function readError(response: Response) {
  const text = await response.text();
  if (!text) {
    return `HTTP ${response.status}`;
  }

  try {
    const payload = JSON.parse(text) as {
      error?: {
        message?: string;
      };
    };
    return payload.error?.message ?? text;
  } catch {
    return text;
  }
}

export function setAuthSigner(nextSigner?: SignMessageFn) {
  signMessageFn = nextSigner;
}

export function clearAuthSession(address: string) {
  inflightSessions.delete(normalizeAddress(address));
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(sessionKey(address));
  }
}

export async function ensureAuthenticated(apiBase: string, address: string) {
  const normalizedAddress = normalizeAddress(address);
  const current = readStoredSession(normalizedAddress);
  if (current && isSessionValid(current)) {
    return current.token;
  }

  const existing = inflightSessions.get(normalizedAddress);
  if (existing) {
    return existing;
  }

  const authPromise = (async () => {
    if (!signMessageFn) {
      throw new Error("Connect your EVM wallet to authenticate this action.");
    }

    const base = trimTrailingSlash(apiBase);
    const challengeResponse = await fetch(`${base}/auth/nonce`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        address: normalizedAddress
      })
    });

    if (!challengeResponse.ok) {
      throw new Error(await readError(challengeResponse));
    }

    const challengePayload = (await challengeResponse.json()) as {
      ok: true;
      result: {
        nonce: string;
        message: string;
      };
    };
    const signature = await signMessageFn({
      message: challengePayload.result.message
    });

    const verifyResponse = await fetch(`${base}/auth/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        address: normalizedAddress,
        nonce: challengePayload.result.nonce,
        signature
      })
    });

    if (!verifyResponse.ok) {
      throw new Error(await readError(verifyResponse));
    }

    const verifyPayload = (await verifyResponse.json()) as {
      ok: true;
      result: StoredSession;
    };
    writeStoredSession(normalizedAddress, verifyPayload.result);
    return verifyPayload.result.token;
  })().finally(() => {
    inflightSessions.delete(normalizedAddress);
  });

  inflightSessions.set(normalizedAddress, authPromise);
  return authPromise;
}
