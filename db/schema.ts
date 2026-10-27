import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// This private Site has one shared training log. Its Sites access allowlist
// protects saved records; every invited visitor can view and edit this log.
export const workoutEntries = sqliteTable("workout_entries", {
  id: text("id").primaryKey(),
  workoutDate: text("workout_date").notNull(),
  exerciseName: text("exercise_name").notNull(),
  payloadJson: text("payload_json").notNull(),
  payloadHash: text("payload_hash").notNull(),
  createdAt: text("created_at").notNull(),
  deletedAt: text("deleted_at"),
}, table => [index("workout_entries_date_idx").on(table.workoutDate)]);

// Reversible removal operations cover both imported records and saved sets.
// The original archive and the saved payloads remain intact.
export const recordDeletions = sqliteTable("record_deletions", {
  id: text("id").primaryKey(),
  recordIdsJson: text("record_ids_json").notNull(),
  createdAt: text("created_at").notNull(),
  restoredAt: text("restored_at"),
});

export const workoutPlans = sqliteTable("workout_plans", {
  id: text("id").primaryKey(),
  workoutDate: text("workout_date").notNull(),
  payloadJson: text("payload_json").notNull(),
  payloadHash: text("payload_hash").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
}, table => [index("workout_plans_date_idx").on(table.workoutDate)]);

// Climbing sessions are independent of strength records and planned workouts.
// Category is part of every saved snapshot and is fixed for a workout identity.
export const climbingWorkouts = sqliteTable("climbing_workouts", {
  id: text("id").primaryKey(),
  workoutDate: text("workout_date").notNull(),
  category: text("category").notNull(),
  payloadJson: text("payload_json").notNull(),
  payloadHash: text("payload_hash").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
}, table => [index("climbing_workouts_category_date_idx").on(table.category, table.workoutDate)]);

// Hangboard protocol snapshots live separately from strength and climbing.
// Imported strength payloads remain intact; sourceEntryId assigns them once.
export const hangboardWorkouts = sqliteTable("hangboard_workouts", {
  id: text("id").primaryKey(),
  workoutDate: text("workout_date").notNull(),
  protocol: text("protocol").notNull(),
  payloadJson: text("payload_json").notNull(),
  payloadHash: text("payload_hash").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
  sourceEntryId: text("source_entry_id").unique(),
  sourcePayloadJson: text("source_payload_json"),
  sourcePayloadHash: text("source_payload_hash"),
}, table => [index("hangboard_workouts_protocol_date_idx").on(table.protocol, table.workoutDate)]);
