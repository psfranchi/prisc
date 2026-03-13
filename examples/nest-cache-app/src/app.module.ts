import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { PrismaCacheService } from "./prisma-cache.service";

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService, PrismaCacheService],
})
export class AppModule {}

