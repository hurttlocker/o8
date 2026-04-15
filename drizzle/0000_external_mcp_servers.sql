CREATE TABLE IF NOT EXISTS `external_mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`command` text NOT NULL,
	`args` text DEFAULT '[]' NOT NULL,
	`env_json` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `external_mcp_servers_name_unique` ON `external_mcp_servers` (`name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_external_mcp_servers_enabled` ON `external_mcp_servers` (`enabled`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_external_mcp_servers_updated_at` ON `external_mcp_servers` (`updated_at`);
