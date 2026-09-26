import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { connect as amqpConnect, type ChannelModel } from "amqplib";
import { PrismaService } from "../../prisma/prisma.service";
import { buildSequenceQueueNames } from "../constants/rabbitmq.constants";

// 1000 = 1 second in ms, 60 = seconds in a minute, 30 = minutes -> 30 minutes in ms.
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

@Injectable()
export class RabbitmqQueueCleanupService {
  private readonly logger = new Logger(RabbitmqQueueCleanupService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  // Per-sequence queues (see buildSequenceQueueNames) are asserted durable
  // and never auto-delete, and bootstrap() in main.ts only ever creates
  // them - it never removes one once a sequence stops being active. Left
  // alone they pile up in RabbitMQ forever. This sweeps sequences that are
  // no longer active and drops their queues once it's safe to do so.
  @Interval(CLEANUP_INTERVAL_MS)
  async cleanupInactiveSequenceQueues() {
    const groups = await this.prisma.templateGroup.findMany({
      select: { id: true, isAi: true, isDelete: true },
    });

    const inactiveIds = groups
      .filter((group) => !(group.isDelete === "0" && group.isAi === 1))
      .map((group) => group.id);

    if (inactiveIds.length === 0) return;

    const url = this.configService.getOrThrow<string>("RABBITMQ_URL");
    const connection = await amqpConnect(url);

    try {
      for (const sequenceId of inactiveIds) {
        const { initialQueue, initialDlq, followupQueue, followupDlq } =
          buildSequenceQueueNames(sequenceId);

        for (const queueName of [
          initialQueue,
          initialDlq,
          followupQueue,
          followupDlq,
        ]) {
          await this.deleteIfEmpty(connection, queueName);
        }
      }
    } finally {
      await connection.close();
    }
  }

  // ifUnused/ifEmpty makes RabbitMQ refuse the delete instead of dropping a
  // queue that still has messages or a live consumer (e.g. a sequence that
  // just went inactive but whose consumer, wired once at boot, hasn't been
  // torn down yet). That refusal closes the channel it was issued on, so
  // each attempt gets its own throwaway channel.
  private async deleteIfEmpty(connection: ChannelModel, queueName: string) {
    const channel = await connection.createChannel();

    try {
      await channel.deleteQueue(queueName, { ifUnused: true, ifEmpty: true });
      this.logger.log(`Deleted inactive-sequence queue ${queueName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (/NOT_FOUND/i.test(message) || /PRECONDITION_FAILED/i.test(message)) {
        return;
      }

      this.logger.warn(`Failed to delete queue ${queueName}: ${message}`);
    } finally {
      try {
        await channel.close();
      } catch {
        // server already closed the channel as part of the error above
      }
    }
  }
}
