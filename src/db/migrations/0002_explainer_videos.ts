import { appendOnlyTriggers, applyStatements } from "./append-only.ts";

// 解説動画の表。collection の表と同じく、事実は積むだけで進捗の列は持たない。
const gateFactTable = (table: string, timeColumn: string) =>
  `CREATE TABLE \`${table}\` (
	\`video_id\` text NOT NULL,
	\`gate\` text NOT NULL,
	\`${timeColumn}\` text NOT NULL,
	FOREIGN KEY (\`video_id\`) REFERENCES \`explainer_videos\`(\`id\`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "${table}_gate" CHECK("${table}"."gate" IN ('produce', 'publish'))
)`;

const tables = [
  "explainer_videos",
  "explainer_plans",
  "explainer_approvals",
  "explainer_rejections",
];

const statements = [
  `CREATE TABLE \`explainer_videos\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`created_at\` text NOT NULL
)`,
  `CREATE TABLE \`explainer_plans\` (
	\`video_id\` text NOT NULL,
	\`plan_key\` text NOT NULL,
	\`title\` text NOT NULL,
	\`points\` text NOT NULL,
	\`sources\` text NOT NULL,
	\`hit_pattern\` text NOT NULL,
	\`recorded_at\` text NOT NULL,
	FOREIGN KEY (\`video_id\`) REFERENCES \`explainer_videos\`(\`id\`) ON UPDATE no action ON DELETE no action
)`,
  "CREATE INDEX `explainer_plans_video_id` ON `explainer_plans` (`video_id`)",
  gateFactTable("explainer_approvals", "approved_at"),
  gateFactTable("explainer_rejections", "rejected_at"),
  ...tables.flatMap(appendOnlyTriggers),
];

export default applyStatements(statements);
