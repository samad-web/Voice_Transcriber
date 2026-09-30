import { Module } from "@nestjs/common";

import { S3Module } from "../../s3/s3.module";
import { ExportsController } from "./exports.controller";

/**
 * The data export engine's HTTP surface (doc 35, migration 0148).
 *
 * `S3Module` is imported because the download route presigns a GET and the
 * cancel route deletes an object; `DbService` and `AuthService` come from the
 * global modules, the same as ImportModule and RecycleBinModule.
 *
 * NOTE what is NOT here: nothing that reads an exported row. That work lives in
 * `apps/worker/src/pipeline/export.ts`, and the separation is the feature - an
 * export of a million leads must not be attempted inside a request.
 */
@Module({
  imports: [S3Module],
  controllers: [ExportsController],
})
export class ExportsModule {}
