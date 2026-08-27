import { Module } from "@nestjs/common";
import { QuotationsController } from "./quotations.controller";

@Module({
  controllers: [QuotationsController],
})
export class QuotationsModule {}
