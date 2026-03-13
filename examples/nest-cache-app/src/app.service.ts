import { Injectable } from "@nestjs/common";
import { PrismaCacheService } from "./prisma-cache.service";

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaCacheService) {}

  async getUser(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
  }

  async updateUser(id: string, data: { name?: string }) {
    return this.prisma.user.update({
      where: { id },
      data,
    });
  }
}

