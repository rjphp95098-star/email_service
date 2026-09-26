import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ValidationPipe, Logger } from "@nestjs/common";
import { MicroserviceOptions, Transport } from "@nestjs/microservices";
import { ConfigService } from "@nestjs/config";
import { connect as amqpConnect } from "amqplib";
import { ResponseInterceptor } from "./common/interceptors/response.interceptor";
import { QUEUES, buildSequenceQueueNames } from "./common/constants/rabbitmq.constants";
import { PrismaService } from "./prisma/prisma.service";

async function assertDeadLetterQueues(
  rabbitmqUrl: string,
  sequenceIds: number[],
) {
  const connection = await amqpConnect(rabbitmqUrl);
  const channel = await connection.createChannel();

  await channel.assertQueue(QUEUES.INITIAL_EMAIL_DLQ, { durable: true });
  await channel.assertQueue(QUEUES.FOLLOWUP_EMAIL_DLQ, { durable: true });

  for (const sequenceId of sequenceIds) {
    const { initialDlq, followupDlq } = buildSequenceQueueNames(sequenceId);
    await channel.assertQueue(initialDlq, { durable: true });
    await channel.assertQueue(followupDlq, { durable: true });
  }

  await channel.close();
  await connection.close();
}

// One RabbitMQ queue per active AI sequence, not one shared queue - a
// sequence paced slowly behind another domain's rate limit would otherwise
// hold up every other sequence's messages sitting behind it in line.
// Limitation: a sequence created/activated after this process boots gets no
// consumer until the next restart, since these queues are wired once at
// startup below.
async function getActiveSequenceIds(prisma: PrismaService): Promise<number[]> {
  const groups = await prisma.templateGroup.findMany({
    where: { isDelete: "0", isAi: 1 },
    select: { id: true },
  });

  return groups.map((group) => group.id);
}

async function bootstrap() {
  const logger = new Logger("Bootstrap");

  const app = await NestFactory.create(AppModule, { rawBody: true });

  const configService = app.get(ConfigService);
  const prisma = app.get(PrismaService);
  const rabbitmqUrl = configService.getOrThrow<string>("RABBITMQ_URL");

  const sequenceIds = await getActiveSequenceIds(prisma);

  await assertDeadLetterQueues(rabbitmqUrl, sequenceIds);
  logger.log("RabbitMQ connected");

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalInterceptors(new ResponseInterceptor());

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [rabbitmqUrl],
      queue: "email_queue",
      queueOptions: {
        durable: true,
        deadLetterExchange: "",
        deadLetterRoutingKey: "email_dead_letter_queue",
      },
      noAck: false,
    },
  });

  // tracking_project's AI-sequence cron publishes each initial/follow-up
  // email's row to its own per-sequence queue (see
  // CronController::publishToEmailQueue) instead of writing user_emails
  // itself - one queue pair per sequence so one sequence's domain pacing
  // can't hold up another sequence's messages behind it in a shared queue.
  // Both @EventPattern handlers (initial-email-queue.consumer.ts,
  // followup-email-queue.consumer.ts) match on message pattern, not on which
  // queue delivered it, so the same two consumer classes serve every
  // sequence's queues without change.
  for (const sequenceId of sequenceIds) {
    const { initialQueue, initialDlq, followupQueue, followupDlq } =
      buildSequenceQueueNames(sequenceId);

    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.RMQ,
      options: {
        urls: [rabbitmqUrl],
        queue: initialQueue,
        queueOptions: {
          durable: true,
          deadLetterExchange: "",
          deadLetterRoutingKey: initialDlq,
        },
        noAck: false,
      },
    });

    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.RMQ,
      options: {
        urls: [rabbitmqUrl],
        queue: followupQueue,
        queueOptions: {
          durable: true,
          deadLetterExchange: "",
          deadLetterRoutingKey: followupDlq,
        },
        noAck: false,
      },
    });
  }

  await app.startAllMicroservices();
  logger.log(
    `RabbitMQ consumers listening (email_queue, ${sequenceIds.length} sequence queue pair(s): ${sequenceIds.join(", ")})`,
  );

  const port = configService.get<number>("PORT") ?? 3000;
  await app.listen(port);
}

bootstrap();
