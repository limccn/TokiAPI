CREATE TABLE `tokimeki_attach_tickets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticket_hash` text NOT NULL,
	`invite_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`invite_id`) REFERENCES `tokimeki_invites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokimeki_attach_tickets_ticket_hash_unique` ON `tokimeki_attach_tickets` (`ticket_hash`);--> statement-breakpoint
CREATE INDEX `tokimeki_attach_tickets_expires_at_idx` ON `tokimeki_attach_tickets` (`expires_at`);--> statement-breakpoint
CREATE TABLE `tokimeki_invites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code_hash` text NOT NULL,
	`created_by` integer,
	`namespace` text NOT NULL,
	`session` text NOT NULL,
	`mode` text NOT NULL,
	`allow_web` integer DEFAULT true NOT NULL,
	`passcode_required` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokimeki_invites_code_hash_unique` ON `tokimeki_invites` (`code_hash`);--> statement-breakpoint
CREATE INDEX `tokimeki_invites_created_by_idx` ON `tokimeki_invites` (`created_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `tokimeki_invites_expires_at_idx` ON `tokimeki_invites` (`expires_at`);