-- CreateIndex
-- Covers both @Cron(EVERY_MINUTE) dispatch queries -
-- NewEmailSendService.dispatchPendingEmails (follow_type='main', is_send=0)
-- and FollowupEmailSendService.runDispatch (follow_type='main', is_send=1,
-- is_deleted=0, unsubscribe=0), both ORDER BY auto_id ASC. The existing
-- index on this table leads with auto_id (already the primary key), so
-- neither query could use it - without this, both become a full table scan
-- every minute once user_emails reaches real volume.
CREATE INDEX `idx_dispatch_lookup` ON `user_emails`(`follow_type`, `is_send`, `is_deleted`, `unsubscribe`, `auto_id`);
