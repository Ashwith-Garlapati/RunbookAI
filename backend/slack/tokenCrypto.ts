/**
 * Slack - bot token encryption at rest (AES-256-GCM).
 *
 * Production requires TOKEN_ENCRYPTION_KEY (32-byte hex or utf8 secret).
 * Dev fallback: reversible base64 with a loud warning (never in production).
 */

import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { logger } from "../observability/logger.js";

function getKey(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  return createHash("sha256").update(raw).digest();
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  if (!key) {
    logger.warn("TokenCrypto", "UnencryptedDevFallback", {});
    return `plain:${Buffer.from(plaintext, "utf8").toString("base64")}`;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

export function decryptToken(stored: string): string {
  if (stored.startsWith("plain:")) {
    return Buffer.from(stored.slice("plain:".length), "base64").toString("utf8");
  }
  if (!stored.startsWith("enc:")) return stored; // legacy plaintext row
  const key = getKey();
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY is required to decrypt stored Slack tokens");
  const [, ivB64, tagB64, dataB64] = stored.split(":");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64 ?? "", "base64"));
  decipher.setAuthTag(Buffer.from(tagB64 ?? "", "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64 ?? "", "base64")),
    decipher.final(),
  ]).toString("utf8");
}
