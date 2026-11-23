CREATE TABLE `tokimeki_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`jti` text NOT NULL,
	`kid` text NOT NULL,
	`namespace` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokimeki_tokens_jti_unique` ON `tokimeki_tokens` (`jti`);--> statement-breakpoint
CREATE INDEX `tokimeki_tokens_user_id_idx` ON `tokimeki_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `tokimeki_tokens_expires_at_idx` ON `tokimeki_tokens` (`expires_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `namespace_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `namespace_short` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_namespace_id_unique` ON `users` (`namespace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_namespace_short_unique` ON `users` (`namespace_short`);