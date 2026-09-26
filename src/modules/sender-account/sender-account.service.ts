import { Injectable } from "@nestjs/common";
import { PrismaService } from "src/prisma/prisma.service";

@Injectable()
export class SenderAccountService {
  constructor(private readonly prisma: PrismaService) {}

  async getSenderById(senderId: number) {
    return this.prisma.smtpSetting.findFirst({
      where: { id: senderId, isDeleted: 0 },
    });
  }

  async getAvailableSender() {
    return this.prisma.smtpSetting.findFirst({
      where: {
        isDeleted: 0,
        emailStatus: "grid",
        sentCount: {
          lt: 2000,
        },
      },
      orderBy: {
        id: "asc",
      },
    });
  }

  async incrementSentCount(senderId: number) {
    return this.prisma.smtpSetting.update({
      where: {
        id: senderId,
      },
      data: {
        sentCount: {
          increment: 1,
        },
      },
    });
  }

  async resetAllSenderCounts() {
    return this.prisma.smtpSetting.updateMany({
      where: {
        isDeleted: 0,
        emailStatus: "grid",
      },
      data: {
        sentCount: 0,
      },
    });
  }

  async getOrRotateSender() {
    let sender = await this.getAvailableSender();

    if (sender) {
      return sender;
    }

    await this.resetAllSenderCounts();

    sender = await this.getAvailableSender();

    if (!sender) {
      throw new Error("No active smtp setting found with email_status=grid");
    }

    return sender;
  }
}
