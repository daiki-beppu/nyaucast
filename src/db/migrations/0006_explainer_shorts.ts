import { appendOnlyTriggers, applyStatements } from "./append-only.ts";

// ショートの候補の版と取り下げの事実（ADR-0009 決定 11）。番号は動画の中での候補の識別子で、版を積むたびに同じ番号の行が増える。
const versions = "explainer_short_versions";
const withdrawals = "explainer_short_withdrawals";

const statements = [
  `CREATE TABLE \`${versions}\` (
	\`video_id\` text NOT NULL,
	\`number\` integer NOT NULL,
	\`start_scene\` integer NOT NULL,
	\`start_paragraph\` integer NOT NULL,
	\`end_scene\` integer NOT NULL,
	\`end_paragraph\` integer NOT NULL,
	\`hook\` text NOT NULL,
	\`script_key\` text NOT NULL,
	\`script_sha256\` text NOT NULL,
	\`created_at\` text NOT NULL,
	FOREIGN KEY (\`video_id\`) REFERENCES \`explainer_videos\`(\`id\`) ON UPDATE no action ON DELETE no action
)`,
  ...appendOnlyTriggers(versions),
  `CREATE TABLE \`${withdrawals}\` (
	\`video_id\` text NOT NULL,
	\`number\` integer NOT NULL,
	\`withdrawn_at\` text NOT NULL,
	FOREIGN KEY (\`video_id\`) REFERENCES \`explainer_videos\`(\`id\`) ON UPDATE no action ON DELETE no action
)`,
  ...appendOnlyTriggers(withdrawals),
];

export default applyStatements(statements);
