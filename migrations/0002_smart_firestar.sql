CREATE TABLE `provider_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`endpoint` text NOT NULL,
	`requested_at` integer NOT NULL,
	`symbol` text,
	`success` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `provider_requests_provider_time_idx` ON `provider_requests` (`provider`,`requested_at`);