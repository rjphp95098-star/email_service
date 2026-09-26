-- AlterTable
-- Domain actually used for this row. Nullable because existing rows predate
-- this column - FollowupEmailSendService and NewEmailSendService both fall
-- back to the sequence's legacy fixed settings_id when this is NULL.
ALTER TABLE `user_emails` ADD COLUMN `smtp_setting_id` INTEGER NULL;

-- No schema change for the domain pool itself: sequence_smtp_settings
-- already exists with the shape this feature needs (sequence_id,
-- smtp_setting_id UNIQUE, created_at) - see the SequenceSmtpSetting model
-- in schema.prisma for how it's read.
