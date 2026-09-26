-- CreateTable
CREATE TABLE `email_signatures` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `content` LONGTEXT NOT NULL,
    `created_by` INTEGER NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `is_deleted` TINYINT NOT NULL DEFAULT 0,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;

-- AlterTable
ALTER TABLE `smtp_settings` ADD COLUMN `signature_id` INTEGER NULL;

-- CreateIndex
CREATE INDEX `idx_signature_id` ON `smtp_settings`(`signature_id`);
