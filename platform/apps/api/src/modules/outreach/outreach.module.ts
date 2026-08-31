import { Module } from "@nestjs/common";
import { OutreachController } from "./outreach.controller";

/** The follow-up ladder - packages/db/migrations/0058. */
@Module({
  controllers: [OutreachController],
})
export class OutreachModule {}
