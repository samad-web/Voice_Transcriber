import { Module } from "@nestjs/common";
import { CrmController } from "./crm.controller";
import { CrmTestService } from "./crm-test.service";

@Module({
  controllers: [CrmController],
  providers: [CrmTestService],
})
export class CrmModule {}
