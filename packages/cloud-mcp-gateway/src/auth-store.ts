import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface UserTokenRecord {
  userId: string;
  revoked?: boolean;
}

export interface DeviceTokenRecord {
  userId: string;
  runtimeId: string;
  runtimeName?: string;
  revoked?: boolean;
}

export interface PairingCodeRecord {
  userId: string;
  expiresAt: number;
}

export interface DeviceTokenIssue {
  userId: string;
  runtimeId: string;
  deviceToken: string;
}

export interface AuthStoreSnapshot {
  version: 1;
  userTokens: Array<UserTokenRecord & { tokenHash: string }>;
  deviceTokens: Array<DeviceTokenRecord & { tokenHash: string }>;
  pairingCodes: Array<PairingCodeRecord & { codeHash: string }>;
}

export class InMemoryAuthStore {
  protected readonly userTokens = new Map<string, UserTokenRecord>();
  protected readonly deviceTokens = new Map<string, DeviceTokenRecord>();
  protected readonly pairingCodes = new Map<string, PairingCodeRecord>();

  constructor(seedUserToken?: { token: string; userId: string }, snapshot?: AuthStoreSnapshot) {
    if (snapshot) this.loadSnapshot(snapshot);
    if (seedUserToken) this.addUserToken(seedUserToken.token, seedUserToken.userId);
  }

  addUserToken(token: string, userId: string): void {
    const key = hashSecret(token);
    const existing = this.userTokens.get(key);
    if (existing?.userId === userId && !existing.revoked) return;
    this.userTokens.set(key, { userId });
    this.afterMutation();
  }

  authenticateUser(token: string | undefined): string | null {
    if (!token) return null;
    const record = this.userTokens.get(hashSecret(token));
    if (!record || record.revoked) return null;
    return record.userId;
  }

  authenticateDevice(token: string | undefined): DeviceTokenRecord | null {
    if (!token) return null;
    const record = this.deviceTokens.get(hashSecret(token));
    if (!record || record.revoked) return null;
    return record;
  }

  createPairingCode(userId: string, ttlMs = 10 * 60 * 1000): { code: string; expiresAt: number } {
    const code = randomBytes(4).toString("hex").toUpperCase();
    const expiresAt = Date.now() + ttlMs;
    this.pairingCodes.set(hashSecret(code), { userId, expiresAt });
    this.afterMutation();
    return { code, expiresAt };
  }

  exchangePairingCode(code: string, runtimeName?: string): DeviceTokenIssue {
    const normalized = code.trim().toUpperCase();
    const codeHash = hashSecret(normalized);
    const record = this.pairingCodes.get(codeHash);
    if (!record || record.expiresAt < Date.now()) {
      this.pairingCodes.delete(codeHash);
      this.afterMutation();
      throw new Error("Pairing code is invalid or expired");
    }
    this.pairingCodes.delete(codeHash);
    const runtimeId = `rt_${randomUUID()}`;
    const deviceToken = `gsd_dev_${randomBytes(32).toString("hex")}`;
    this.deviceTokens.set(hashSecret(deviceToken), { userId: record.userId, runtimeId, runtimeName });
    this.afterMutation();
    return { userId: record.userId, runtimeId, deviceToken };
  }

  revokeDeviceToken(deviceToken: string): boolean {
    const record = this.deviceTokens.get(hashSecret(deviceToken));
    if (!record) return false;
    record.revoked = true;
    this.afterMutation();
    return true;
  }

  snapshot(): AuthStoreSnapshot {
    return {
      version: 1,
      userTokens: Array.from(this.userTokens, ([tokenHash, record]) => ({ tokenHash, ...record })),
      deviceTokens: Array.from(this.deviceTokens, ([tokenHash, record]) => ({ tokenHash, ...record })),
      pairingCodes: Array.from(this.pairingCodes, ([codeHash, record]) => ({ codeHash, ...record })),
    };
  }

  protected afterMutation(): void {
    // Extension point for persistent stores.
  }

  private loadSnapshot(snapshot: AuthStoreSnapshot): void {
    for (const record of snapshot.userTokens ?? []) {
      this.userTokens.set(record.tokenHash, { userId: record.userId, revoked: record.revoked });
    }
    for (const record of snapshot.deviceTokens ?? []) {
      this.deviceTokens.set(record.tokenHash, {
        userId: record.userId,
        runtimeId: record.runtimeId,
        runtimeName: record.runtimeName,
        revoked: record.revoked,
      });
    }
    for (const record of snapshot.pairingCodes ?? []) {
      if (record.expiresAt >= Date.now()) {
        this.pairingCodes.set(record.codeHash, { userId: record.userId, expiresAt: record.expiresAt });
      }
    }
  }
}

export class FileAuthStore extends InMemoryAuthStore {
  private readonly filePath: string;

  constructor(
    filePath: string,
    seedUserToken?: { token: string; userId: string },
  ) {
    super(undefined, readSnapshot(filePath));
    this.filePath = filePath;
    if (seedUserToken) this.addUserToken(seedUserToken.token, seedUserToken.userId);
    this.persist();
  }

  protected override afterMutation(): void {
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.snapshot(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}

export function extractBearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value.length <= "Bearer ".length) return undefined;
  if (value.slice(0, "Bearer".length).toLowerCase() !== "bearer") return undefined;

  const firstSeparator = value.charCodeAt("Bearer".length);
  if (firstSeparator !== 0x20 && firstSeparator !== 0x09) return undefined;

  let tokenStart = "Bearer".length + 1;
  while (tokenStart < value.length) {
    const char = value.charCodeAt(tokenStart);
    if (char !== 0x20 && char !== 0x09) break;
    tokenStart += 1;
  }

  return tokenStart < value.length ? value.slice(tokenStart) : undefined;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function readSnapshot(filePath: string): AuthStoreSnapshot | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<AuthStoreSnapshot>;
    if (parsed.version !== 1) return undefined;
    return {
      version: 1,
      userTokens: Array.isArray(parsed.userTokens) ? parsed.userTokens as AuthStoreSnapshot["userTokens"] : [],
      deviceTokens: Array.isArray(parsed.deviceTokens) ? parsed.deviceTokens as AuthStoreSnapshot["deviceTokens"] : [],
      pairingCodes: Array.isArray(parsed.pairingCodes) ? parsed.pairingCodes as AuthStoreSnapshot["pairingCodes"] : [],
    };
  } catch {
    return undefined;
  }
}
