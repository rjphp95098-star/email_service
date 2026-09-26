import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "src/prisma/prisma.service";
import { generateWebhookGuid } from "src/common/utils/guid.util";
import { CreateWebhookEventData } from "./types/create-webhook-event.type";

@Injectable()
export class WebhookEventService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inserts the row, using data.guid (SendGrid's sg_event_id, when given)
   * as the row's guid instead of always generating a random one - that's
   * what makes the table's existing @unique guid index actually catch a
   * retried webhook delivery instead of letting every retry insert a fresh
   * "duplicate" row under its own random guid.
   *
   * @return bool  true if inserted, false if this guid already existed
   *               (a retried delivery of the same SendGrid event) - the
   *               caller must skip every other side effect (open count,
   *               status update, ...) for a false return, not just this insert.
   */
  async create(data: CreateWebhookEventData): Promise<boolean> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          guid: data.guid || generateWebhookGuid(),

          userEmailId: data.userEmailId,

          eventType: data.eventType,

          eventTimestamp: data.eventTimestamp,

          webhookPayload: data.webhookPayload,
        },
      });

      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return false;
      }

      throw error;
    }
  }
}
