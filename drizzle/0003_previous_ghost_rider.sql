CREATE TABLE `hangboard_workouts` (
	`id` text PRIMARY KEY NOT NULL,
	`workout_date` text NOT NULL,
	`protocol` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`source_entry_id` text,
	`source_payload_json` text,
	`source_payload_hash` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hangboard_workouts_source_entry_id_unique` ON `hangboard_workouts` (`source_entry_id`);--> statement-breakpoint
CREATE INDEX `hangboard_workouts_protocol_date_idx` ON `hangboard_workouts` (`protocol`,`workout_date`);