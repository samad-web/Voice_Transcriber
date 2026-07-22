import { createHmac, timingSafeEqual } from "node:crypto";

const NONCE_TTL_MS = 2 * 60 * 1000;

const secret = () => process.env.JWT_SECRET ?? "dev-jwt-secret-change-me";

/**
 * Stateless HMAC nonce for the device auth challenge (design doc §3.2).
 * TODO (checklist §2.2): make single-use via Redis once it is wired in —
 * stateless nonces are replayable within their 2-minute TTL.
 */
export function issueNonce(deviceId: string): string {
  const payload = `${deviceId}.${Date.now() + NONCE_TTL_MS}`;
  const mac = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${mac}`;
}

export function verifyNonce(nonce: string, deviceId: string): boolean {
  const [payloadB64, mac] = nonce.split(".");
  if (!payloadB64 || !mac) return false;
  const payload = Buffer.from(payloadB64, "base64url").toString();
  const expectedMac = createHmac("sha256", secret()).update(payload).digest("base64url");
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expectedMac);
  if (macBuf.length !== expectedBuf.length || !timingSafeEqual(macBuf, expectedBuf)) return false;
  const [noncedDeviceId, expStr] = payload.split(".");
  return noncedDeviceId === deviceId && Number(expStr) > Date.now();
}
