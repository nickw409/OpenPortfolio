ALTER TABLE `accounts` ADD `cost_basis_method` text DEFAULT 'fifo' NOT NULL;--> statement-breakpoint
DROP VIEW `positions`;