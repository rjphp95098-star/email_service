-- CreateTable
CREATE TABLE `sender_accounts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `guid` VARCHAR(191) NOT NULL,
    `fromEmail` VARCHAR(191) NOT NULL,
    `fromName` VARCHAR(191) NOT NULL,
    `sentCount` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sender_accounts_guid_key`(`guid`),
    UNIQUE INDEX `sender_accounts_fromEmail_key`(`fromEmail`),
    INDEX `sender_accounts_guid_idx`(`guid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `email_templates` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `guid` VARCHAR(191) NOT NULL,
    `templateName` VARCHAR(191) NOT NULL,
    `subject` VARCHAR(191) NOT NULL,
    `htmlContent` LONGTEXT NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `email_templates_guid_key`(`guid`),
    UNIQUE INDEX `email_templates_templateName_key`(`templateName`),
    INDEX `email_templates_guid_idx`(`guid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `email_lists` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `guid` VARCHAR(191) NOT NULL,
    `senderAccountId` INTEGER NOT NULL,
    `templateId` INTEGER NULL,
    `recipientEmail` VARCHAR(191) NOT NULL,
    `subject` VARCHAR(191) NOT NULL,
    `bodyContent` LONGTEXT NOT NULL,
    `requestPayload` JSON NOT NULL,
    `status` ENUM('QUEUED', 'PROCESSED', 'DELIVERED', 'OPENED', 'CLICKED', 'BOUNCED', 'DROPPED', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `email_lists_guid_key`(`guid`),
    INDEX `email_lists_guid_idx`(`guid`),
    INDEX `email_lists_recipientEmail_idx`(`recipientEmail`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `guid` VARCHAR(191) NOT NULL,
    `emailGuid` VARCHAR(191) NOT NULL,
    `emailListId` INTEGER NOT NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `eventTimestamp` DATETIME(3) NOT NULL,
    `webhookPayload` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `webhook_events_guid_key`(`guid`),
    INDEX `webhook_events_guid_idx`(`guid`),
    INDEX `webhook_events_emailGuid_idx`(`emailGuid`),
    INDEX `webhook_events_emailListId_idx`(`emailListId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `email_lists` ADD CONSTRAINT `email_lists_senderAccountId_fkey` FOREIGN KEY (`senderAccountId`) REFERENCES `sender_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `email_lists` ADD CONSTRAINT `email_lists_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `email_templates`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `webhook_events` ADD CONSTRAINT `webhook_events_emailListId_fkey` FOREIGN KEY (`emailListId`) REFERENCES `email_lists`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
