DROP INDEX `balance_tx_bonus_once_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `balance_tx_bonus_once_idx` ON `balance_tx` (`user_id`,`type`) WHERE "balance_tx"."type" IN ('signup_bonus', 'email_verify_bonus', 'github_bind_bonus');--> statement-breakpoint
ALTER TABLE `users` ADD `github_bind_bonus_granted_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `bonus_eligible` integer DEFAULT true NOT NULL;--> statement-breakpoint
-- 存量账号冻结（11-08-reward-semantics-overhaul）：迁移时刻已存在的行永久无赠金资格。
-- 必须与 ADD COLUMN 同一迁移：分两次会导致「新列默认 true」的窗口里新老账号都具备资格。
UPDATE `users` SET `bonus_eligible` = false;