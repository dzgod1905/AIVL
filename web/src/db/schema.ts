import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Workflow definition. IO detail lives in the orchestrator's SQLite, not here.
export const workflows = pgTable("workflows", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const workflowSteps = pgTable("workflow_steps", {
  id: uuid("id").defaultRandom().primaryKey(),
  workflowId: uuid("workflow_id").notNull(),
  order: integer("order").notNull().default(0), // display only
  stepKey: text("step_key").notNull(),
  unitId: text("unit_id").notNull(),
  unitType: text("unit_type").notNull(), // ai_agent | automation_tool
  source: text("source").notNull(), // ai | automation
  promptTemplate: text("prompt_template"),
  contextMapping: jsonb("context_mapping").$type<Record<string, string>>().default({}),
  apiConfig: jsonb("api_config").$type<Record<string, unknown>>().default({}),
  dependsOn: jsonb("depends_on").$type<string[]>().default([]),
  humanInvolved: boolean("human_involved").notNull().default(false),
  maxAttempts: integer("max_attempts").notNull().default(5),
  timeoutSec: integer("timeout_sec").notNull().default(30),
});

// Only metadata + a pointer to the orchestrator run. No detailed IO.
export const workflowRuns = pgTable("workflow_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workflowId: uuid("workflow_id").notNull(),
  orchestratorRunId: text("orchestrator_run_id").notNull(),
  status: text("status").notNull().default("running"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
