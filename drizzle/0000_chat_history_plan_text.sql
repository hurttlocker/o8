CREATE TABLE IF NOT EXISTS `chat_history` (
  `tab_id` text PRIMARY KEY NOT NULL,
  `messages_json` text DEFAULT '[]' NOT NULL,
  `model` text,
  `saved_at` text,
  `modified_at` text DEFAULT (datetime('now')) NOT NULL,
  `starred` integer DEFAULT 0 NOT NULL,
  `title` text,
  `plan_text` text,
  `repo_name` text,
  `repo_path` text,
  `repo_branch` text,
  `remote_url` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chat_history_modified_at` ON `chat_history` (`modified_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chat_history_repo_path` ON `chat_history` (`repo_path`);
