import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { recoverMessageAddress } from "viem";

type AuthChallengeRecord = {
  nonce: string;
  expiresAt: number;
};

type TokenPayload = {
  sub: string;
  exp: number;
  v: 1;
};

function normalizeAddress(address: string) {
  return address.toLowerCase();
}

function encodeBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

export class MatcherAuthService {
  private readonly challenges = new Map<string, AuthChallengeRecord>();

  constructor(
    private readonly options: {
      secret: string;
      nonceTtlMs: number;
      tokenTtlMs: number;
    }
  ) {}

  createChallenge(address: string) {
    this.pruneExpiredChallenges();

    const normalizedAddress = normalizeAddress(address);
    const nonce = `0x${randomBytes(16).toString("hex")}`;
    const expiresAt = Date.now() + this.options.nonceTtlMs;
    this.challenges.set(normalizedAddress, { nonce, expiresAt });

    return {
      nonce,
      message: this.buildMessage(normalizedAddress, nonce),
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  async verifyChallenge(input: {
    address: string;
    nonce: string;
    signature: `0x${string}`;
  }) {
    this.pruneExpiredChallenges();

    const normalizedAddress = normalizeAddress(input.address);
    const challenge = this.challenges.get(normalizedAddress);
    if (!challenge) {
      throw new Error("Authentication challenge not found or expired.");
    }

    if (challenge.nonce !== input.nonce) {
      throw new Error("Authentication challenge does not match the active nonce.");
    }

    const recoveredAddress = await recoverMessageAddress({
      message: this.buildMessage(normalizedAddress, input.nonce),
      signature: input.signature
    });

    this.challenges.delete(normalizedAddress);

    if (normalizeAddress(recoveredAddress) !== normalizedAddress) {
      throw new Error("Signature does not match the requested wallet address.");
    }

    return this.issueToken(normalizedAddress);
  }

  verifyToken(token: string) {
    const [encodedPayload, encodedSignature] = token.split(".");
    if (!encodedPayload || !encodedSignature) {
      throw new Error("Malformed auth token.");
    }

    const expectedSignature = this.sign(encodedPayload);
    const receivedSignature = Buffer.from(encodedSignature, "base64url");

    if (
      expectedSignature.length !== receivedSignature.length ||
      !timingSafeEqual(expectedSignature, receivedSignature)
    ) {
      throw new Error("Invalid auth token signature.");
    }

    const payload = JSON.parse(decodeBase64Url(encodedPayload)) as TokenPayload;
    if (payload.v !== 1 || typeof payload.sub !== "string" || typeof payload.exp !== "number") {
      throw new Error("Malformed auth token payload.");
    }

    if (payload.exp <= Date.now()) {
      throw new Error("Auth token expired.");
    }

    return {
      address: payload.sub,
      expiresAt: new Date(payload.exp).toISOString()
    };
  }

  refreshToken(token: string) {
    const session = this.verifyToken(token);
    return this.issueToken(session.address);
  }

  private issueToken(address: string) {
    const expiresAt = Date.now() + this.options.tokenTtlMs;
    const payload: TokenPayload = {
      sub: normalizeAddress(address),
      exp: expiresAt,
      v: 1
    };
    const encodedPayload = encodeBase64Url(JSON.stringify(payload));
    const signature = this.sign(encodedPayload).toString("base64url");

    return {
      token: `${encodedPayload}.${signature}`,
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  private buildMessage(address: string, nonce: string) {
    return [
      "Sign this message to authenticate with Sinergy.",
      "",
      `Address: ${address}`,
      `Nonce: ${nonce}`,
      "",
      "This request does not trigger a blockchain transaction."
    ].join("\n");
  }

  private pruneExpiredChallenges() {
    const now = Date.now();
    for (const [address, challenge] of this.challenges.entries()) {
      if (challenge.expiresAt <= now) {
        this.challenges.delete(address);
      }
    }
  }

  private sign(encodedPayload: string) {
    return createHmac("sha256", this.options.secret).update(encodedPayload).digest();
  }
}
