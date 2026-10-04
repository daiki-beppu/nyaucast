import { appendOnlyTriggers, applyStatements } from "./append-only.ts";

// 公開ゲートが作る投稿と、agent のショートの推奨の事実（ADR-0009 決定 9・10）。
// 投稿はカットを名前で指し、採用は独立した事実にしない。id は投稿単位の CLI が投稿を指すための主キー。
const posts = "explainer_posts";
const recommendations = "explainer_short_recommendations";

const statements = [
  `CREATE TABLE \`${posts}\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`video_id\` text NOT NULL,
	\`cut\` text NOT NULL,
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
  ...appendOnlyTriggers(posts),
  `CREATE TABLE \`${recommendations}\` (
	\`video_id\` text NOT NULL,
	\`number\` integer NOT NULL,
	\`cut\` text NOT NULL CHECK (\`cut\` IN ('clip', 'dedicated', 'none')),
	\`recommended_at\` text NOT NULL,
	FOREIGN KEY (\`video_id\`) REFERENCES \`explainer_videos\`(\`id\`) ON UPDATE no action ON DELETE no action
)`,
  ...appendOnlyTriggers(recommendations),
];

export default applyStatements(statements);
