CREATE TABLE `workout_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`workout_date` text NOT NULL,
	`exercise_name` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `workout_entries_date_idx` ON `workout_entries` (`workout_date`);