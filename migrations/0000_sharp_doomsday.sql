CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`broker` text,
	`tax_treatment` text NOT NULL,
	`currency_code` text DEFAULT 'USD' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`at_ms` integer NOT NULL,
	`actor` text DEFAULT 'user' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity_type`,`entity_id`,`at_ms`);--> statement-breakpoint
CREATE INDEX `audit_log_chrono_idx` ON `audit_log` (`at_ms`);--> statement-breakpoint
CREATE TABLE `cpi_data` (
	`series_id` text NOT NULL,
	`period_date` integer NOT NULL,
	`index_value` real NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`series_id`, `period_date`)
);
--> statement-breakpoint
CREATE TABLE `dashboard_layouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `price_history` (
	`security_id` integer NOT NULL,
	`price_date` integer NOT NULL,
	`close_cents` integer NOT NULL,
	`source` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`security_id`, `price_date`),
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `securities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`exchange` text NOT NULL,
	`asset_class` text NOT NULL,
	`name` text,
	`cusip` text,
	`isin` text,
	`currency_code` text DEFAULT 'USD' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `securities_symbol_exchange_unique` ON `securities` (`symbol`,`exchange`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `tile_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`layout_id` integer NOT NULL,
	`tile_type` text NOT NULL,
	`position_json` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`layout_id`) REFERENCES `dashboard_layouts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `transaction_tags` (
	`transaction_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`transaction_id`, `tag_id`),
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`security_id` integer,
	`transaction_type` text NOT NULL,
	`transaction_date` integer NOT NULL,
	`settlement_date` integer,
	`quantity` real DEFAULT 0 NOT NULL,
	`price_cents` integer,
	`amount_cents` integer NOT NULL,
	`fee_cents` integer,
	`currency_code` text DEFAULT 'USD' NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transactions_account_date_idx` ON `transactions` (`account_id`,`transaction_date`);--> statement-breakpoint
CREATE INDEX `transactions_security_date_idx` ON `transactions` (`security_id`,`transaction_date`);--> statement-breakpoint
CREATE VIEW `positions` AS select "account_id", "security_id", SUM(
        CASE "transaction_type"
          WHEN 'buy' THEN "quantity"
          WHEN 'transfer_in' THEN "quantity"
          WHEN 'split' THEN "quantity"
          WHEN 'sell' THEN -"quantity"
          WHEN 'transfer_out' THEN -"quantity"
          ELSE 0
        END
      ) as "quantity", SUM(
        CASE "transaction_type"
          WHEN 'buy' THEN "amount_cents"
          WHEN 'transfer_in' THEN "amount_cents"
          WHEN 'sell' THEN -"amount_cents"
          WHEN 'transfer_out' THEN -"amount_cents"
          ELSE 0
        END
      ) as "cost_basis_cents" from "transactions" where "transactions"."deleted_at" IS NULL AND "transactions"."security_id" IS NOT NULL group by "transactions"."account_id", "transactions"."security_id";