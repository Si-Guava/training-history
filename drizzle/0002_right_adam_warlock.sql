CREATE TABLE `climbing_workouts` (
	`id` text PRIMARY KEY NOT NULL,
	`workout_date` text NOT NULL,
	`category` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `climbing_workouts_category_date_idx` ON `climbing_workouts` (`category`,`workout_date`);