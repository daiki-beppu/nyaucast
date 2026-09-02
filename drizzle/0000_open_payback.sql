CREATE TABLE `approvals` (
	`collection_id` text NOT NULL,
	`gate` text NOT NULL,
	`approved_at` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approvals_gate" CHECK("approvals"."gate" IN ('produce', 'publish'))
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
	`rejected_at` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "rejections_gate" CHECK("rejections"."gate" IN ('produce', 'publish'))
);
--> statement-breakpoint
CREATE TABLE `thumbnails` (
	`collection_id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TRIGGER `approvals_no_update`
BEFORE UPDATE ON `approvals`
BEGIN
	SELECT RAISE(ABORT, 'approvals are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `approvals_no_delete`
BEFORE DELETE ON `approvals`
BEGIN
	SELECT RAISE(ABORT, 'approvals are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `rejections_no_update`
BEFORE UPDATE ON `rejections`
BEGIN
	SELECT RAISE(ABORT, 'rejections are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `rejections_no_delete`
BEFORE DELETE ON `rejections`
BEGIN
	SELECT RAISE(ABORT, 'rejections are append-only');
END;
