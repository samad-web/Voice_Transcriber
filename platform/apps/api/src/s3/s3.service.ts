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

/** Direct-to-S3 uploads — audio never flows through the API process (§6.1). */
@Injectable()
export class S3Service {
  private static readonly creds = {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "aura_minio",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "aura_minio_password",
  };
  private static readonly region = process.env.S3_REGION ?? "ap-south-1";

  /** Internal endpoint (localhost/MinIO) — all server-side reads/writes go here. */
  private readonly client = new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
    region: S3Service.region,
    forcePathStyle: true,
    credentials: S3Service.creds,
  });

  /**
   * Public endpoint (e.g. an ngrok tunnel) — used ONLY to presign the device's
   * multipart upload URLs so a remote phone can reach object storage. Falls back
   * to the internal endpoint when no public endpoint is set. Keeping server reads
   * off this endpoint avoids ngrok's browser-warning page corrupting S3 responses.
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

  /** Short-lived presigned GET — lets the web player stream audio without the bytes touching the API. */
  async presignedGetUrl(key: string, expiresIn = 300): Promise<string> {
    return getSignedUrl(
      this.client,
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
