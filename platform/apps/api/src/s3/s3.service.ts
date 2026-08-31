import { Injectable } from "@nestjs/common";
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const PART_SIZE_BYTES = 5 * 1024 * 1024;

/** Direct-to-S3 uploads - audio never flows through the API process (§6.1). */
@Injectable()
export class S3Service {
  private static readonly creds = {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "aura_minio",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "aura_minio_password",
  };
  private static readonly region = process.env.S3_REGION ?? "ap-south-1";

  /** Internal endpoint (localhost/MinIO) - all server-side reads/writes go here. */
  private readonly client = new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
    region: S3Service.region,
    forcePathStyle: true,
    credentials: S3Service.creds,
  });

  /**
   * Public endpoint (`S3_PUBLIC_ENDPOINT`, e.g. https://storage.<APP_DOMAIN>) -
   * used to presign every URL that leaves the server: the device's multipart
   * upload parts and the console's playback GET. Falls back to the internal
   * endpoint when unset, which is what makes local dev work unconfigured.
   *
   * Server-side reads deliberately stay on `client` below: they run inside the
   * compose network and should not take the public TLS/proxy hop.
   */
  private readonly publicClient = new S3Client({
    endpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT ?? "http://localhost:9000",
    region: S3Service.region,
    forcePathStyle: true,
    credentials: S3Service.creds,
  });

  private readonly bucket = process.env.S3_BUCKET ?? "aura-recordings";

  async createMultipartUpload(key: string, bytes: number) {
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        // So the stored object (and its playback URL) is served as playable audio.
        ContentType: "audio/mp4",
      }),
    );
    if (!UploadId) throw new Error("S3 did not return an upload id");

    const partCount = Math.max(1, Math.ceil(bytes / PART_SIZE_BYTES));
    const partUrls = await Promise.all(
      Array.from({ length: partCount }, (_, i) =>
        getSignedUrl(
          this.publicClient,
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId,
            PartNumber: i + 1,
          }),
          { expiresIn: 3600 },
        ),
      ),
    );
    return { uploadId: UploadId, partUrls, partSizeBytes: PART_SIZE_BYTES };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ n: number; etag: string }>,
  ) {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .sort((a, b) => a.n - b.n)
            .map((p) => ({ PartNumber: p.n, ETag: p.etag })),
        },
      }),
    );
  }

  async headObject(key: string): Promise<{ bytes: number }> {
    const head = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return { bytes: head.ContentLength ?? 0 };
  }

  /**
   * Short-lived presigned GET - lets the web player stream audio without the
   * bytes touching the API.
   *
   * Signed with the PUBLIC client: this URL is handed to a browser, so it must
   * address storage the way the browser can reach it. In production the internal
   * endpoint is `http://minio:9000`, a Docker-network name that resolves nowhere
   * outside the compose network - signing with it produced a URL the player
   * could never load. (It only appeared to work in dev, where the internal
   * endpoint happens to be localhost and the browser is on the same host.)
   *
   * SigV4 signs the Host header, so the endpoint used here must be exactly the
   * host the browser requests, or MinIO rejects it with SignatureDoesNotMatch.
   *
   * Expiry covers playback, not just the click: the player issues Range requests
   * for the whole session, and a signature that dies mid-file breaks seeking on
   * any recording longer than the window. 300s was shorter than a six-minute
   * call.
   */
  async presignedGetUrl(key: string, expiresIn = 1800): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // Force a playable content-type even for objects stored as octet-stream.
        ResponseContentType: "audio/mp4",
      }),
      { expiresIn },
    );
  }
}
