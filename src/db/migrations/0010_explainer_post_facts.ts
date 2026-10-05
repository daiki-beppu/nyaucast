import { appendOnlyTriggers, applyStatements } from "./append-only.ts";

// 取り消し・公開済み・upload の拒否の事実（issue #554、ADR-0009 決定 9・13）。
// 人間の意思（取り消し・公開済みの記録）と API の観測（公開の確認・upload の拒否）を同じ行の
// 形に混ぜないため、事実の種類ごとに表を分ける（explainer_thumbnail_rejections と同じ形）。
const cancellations = "explainer_post_cancellations";
const publications = "explainer_post_publications";
const uploadFailures = "explainer_post_upload_failures";

const statements = [
  `CREATE TABLE \`${cancellations}\` (
	\`post_id\` integer NOT NULL,
	\`recorded_at\` text NOT NULL,
	FOREIGN KEY (\`post_id\`) REFERENCES \`explainer_posts\`(\`id\`) ON UPDATE no action ON DELETE no action
)`,
  ...appendOnlyTriggers(cancellations),
  `CREATE TABLE \`${publications}\` (
	\`post_id\` integer NOT NULL,
	\`remote_url\` text,
	\`recorded_at\` text NOT NULL,
	FOREIGN KEY (\`post_id\`) REFERENCES \`explainer_posts\`(\`id\`) ON UPDATE no action ON DELETE no action
)`,
  ...appendOnlyTriggers(publications),
  `CREATE TABLE \`${uploadFailures}\` (
	\`post_id\` integer NOT NULL,
	\`upload_status\` text NOT NULL CHECK (\`upload_status\` IN ('rejected', 'failed')),
	\`recorded_at\` text NOT NULL,
	FOREIGN KEY (\`post_id\`) REFERENCES \`explainer_posts\`(\`id\`) ON UPDATE no action ON DELETE no action
)`,
  ...appendOnlyTriggers(uploadFailures),
];

export default applyStatements(statements);
