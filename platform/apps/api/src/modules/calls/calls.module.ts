import { Module } from "@nestjs/common";
import { CallsController } from "./calls.controller";
import { NotesController } from "./notes.controller";

@Module({
  controllers: [CallsController, NotesController],
})
export class CallsModule {}
