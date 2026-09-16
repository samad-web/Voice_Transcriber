import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { initializeApp, getApps, cert, ServiceAccount } from "firebase-admin/app";
import { getMessaging, Messaging } from "firebase-admin/messaging";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Firebase Cloud Messaging push channel (hardening plan §3.4).
 *
 * Sends high-priority DATA messages so Android delivers them even in Doze mode
 * and the app's FirebaseMessagingService runs without user interaction. Data
 * messages carry no visible notification - the app decides what to do
 * (typically: trigger a config refresh).
 *
 * Takes its credential from either:
 *   FIREBASE_SERVICE_ACCOUNT_B64  - base64 of the service-account JSON. Use
 *     this in containers. It arrives through env_file with every other secret,
 *     so there is no bind mount to forget and no key file on the host.
 *   FIREBASE_SERVICE_ACCOUNT_PATH - path to the JSON on disk, for local dev.
 *
 * B64 wins if both are set. Gracefully no-ops when neither is, so dev
 * environments without a Firebase project still boot. Every caller gets a
 * `false` return and can fall back to the poll path.
 */
@Injectable()
export class FcmService implements OnModuleInit {
  private readonly logger = new Logger(FcmService.name);
  private messaging: Messaging | null = null;

  onModuleInit() {
    const serviceAccount = this.readServiceAccount();
    if (!serviceAccount) {
      this.logger.warn(
        "No Firebase credential (set FIREBASE_SERVICE_ACCOUNT_B64, or " +
          "FIREBASE_SERVICE_ACCOUNT_PATH for local dev) - FCM push disabled; " +
          "logout/wipe will propagate on the ~1h config poll.",
      );
      return;
    }

    try {
      // Guard against multiple initialisations (e.g. HMR in dev).
      if (getApps().length === 0) {
        initializeApp({
          credential: cert(serviceAccount),
        });
      }
      this.messaging = getMessaging();
      const project = (serviceAccount as { project_id?: string }).project_id ?? "unknown";
      // Name the project: a key for the WRONG Firebase project initialises
      // perfectly and then every send fails with a token/sender mismatch, which
      // is otherwise only visible one push at a time in the warn below.
      this.logger.log(`FCM push enabled (project ${project})`);
    } catch (err) {
      this.logger.error("Failed to initialise Firebase Admin - FCM push disabled", err);
    }
  }

  /**
   * Returns null - never throws - so a bad or absent credential degrades to the
   * poll path instead of preventing the API from booting. Losing push is an
   * inconvenience; an API that will not start takes every device upload with it.
   */
  private readServiceAccount(): ServiceAccount | null {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    if (b64) {
      try {
        return JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
      } catch (err) {
        this.logger.error(
          "FIREBASE_SERVICE_ACCOUNT_B64 is not base64-encoded JSON - FCM push disabled",
          err,
        );
        return null;
      }
    }

    // No raw-JSON env var on purpose: the private key's embedded "\n"s do not
    // survive docker compose's env parsing intact, and the resulting failure
    // surfaces at cert() as an opaque "Failed to parse private key" rather than
    // as anything pointing at the env var. Base64 has no such edge.
    const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (!keyPath) return null;
    try {
      return JSON.parse(readFileSync(resolve(keyPath), "utf-8"));
    } catch (err) {
      this.logger.error(
        `Could not read the Firebase service account at ${keyPath} - FCM push disabled`,
        err,
      );
      return null;
    }
  }

  /**
   * Send a data-only, high-priority push to a single device.
   *
   * Returns `true` if the message was accepted by FCM, `false` on any failure
   * (disabled, bad token, network error). Callers must not depend on push
   * delivery for correctness - the config poll is the guaranteed fallback.
   */
  async sendToDevice(
    fcmToken: string,
    data: Record<string, string>,
  ): Promise<boolean> {
    if (!this.messaging) return false;
    try {
      await this.messaging.send({
        token: fcmToken,
        data,
        android: {
          // HIGH priority wakes the device from Doze and lets the
          // FirebaseMessagingService run for up to 20 seconds.
          priority: "high",
        },
      });
      return true;
    } catch (err: any) {
      // messaging/registration-token-not-registered means the token is stale
      // (app uninstalled, token rotated). Log at debug, not error.
      const code = err?.errorInfo?.code ?? "";
      if (code === "messaging/registration-token-not-registered") {
        this.logger.debug(`Stale FCM token - push skipped`);
      } else {
        this.logger.warn(`FCM push failed: ${err?.message ?? err}`);
      }
      return false;
    }
  }
}
