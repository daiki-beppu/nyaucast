CREATE TABLE `approvals` (
	`collection_id` text NOT NULL,
	`gate` text NOT NULL,
	`approved_at` integer NOT NULL,
	PRIMARY KEY(`collection_id`, `gate`, `approved_at`),
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "approvals_gate_check" CHECK("approvals"."gate" in ('produce', 'publish'))
);
--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_title_unique` ON `collections` (`title`);--> statement-breakpoint
CREATE TABLE `rejections` (
	`collection_id` text NOT NULL,
	`gate` text NOT NULL,
	`rejected_at` integer NOT NULL,
	PRIMARY KEY(`collection_id`, `gate`, `rejected_at`),
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "rejections_gate_check" CHECK("rejections"."gate" in ('produce', 'publish'))
);
