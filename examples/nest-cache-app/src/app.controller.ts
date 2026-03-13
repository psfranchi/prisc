import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { AppService } from "./app.service";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get("user")
  getUser(@Query("id") id: string) {
    return this.appService.getUser(id);
  }

  @Patch("user/:id")
  updateUser(@Param("id") id: string, @Body() body: { name?: string }) {
    return this.appService.updateUser(id, body);
  }
}

