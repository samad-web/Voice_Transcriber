import { Module } from "@nestjs/common";
import { ImportController } from "./import.controller";

@Module({
  controllers: [ImportController],
})
export class ImportModule {}
