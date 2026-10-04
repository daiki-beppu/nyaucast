import { appendOnlyTriggers, applyStatements } from "./append-only.ts";

// 投稿案の事実（ADR-0009 決定 10）。キーは動画・ショートの候補の番号（NULL は長尺）・アカウント（SNS と宣言の不変の ID）で、カットを含まない。
// YouTube の投稿文は title と description、Instagram と X の投稿文は body。
const drafts = "explainer_post_drafts";

const statements = [
  `CREATE TABLE \`${drafts}\` (
	\`video_id\` text NOT NULL,
	\`short_number\` integer,
	\`platform\` text NOT NULL,
	\`account_id\` text NOT NULL,
	\`title\` text,
	\`description\` text,
	\`body\` text,
	\`scheduled_at\` text NOT NULL,
	\`created_at\` text NOT NULL,
	FOREIGN KEY (\`video_id\`) REFERENCES \`explainer_videos\`(\`id\`) ON UPDATE no action ON DELETE no action
)`,
  ...appendOnlyTriggers(drafts),
];

export default applyStatements(statements);
