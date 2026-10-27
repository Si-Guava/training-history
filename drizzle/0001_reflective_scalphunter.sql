CREATE TABLE `record_deletions` (
	`id` text PRIMARY KEY NOT NULL,
	`record_ids_json` text NOT NULL,
	`created_at` text NOT NULL,
	`restored_at` text
);
--> statement-breakpoint
CREATE TABLE `workout_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`workout_date` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `workout_plans_date_idx` ON `workout_plans` (`workout_date`);