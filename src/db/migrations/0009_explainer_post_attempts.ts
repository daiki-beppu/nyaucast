import { appendOnlyTriggers, applyStatements } from "./append-only.ts";

// 投稿の試行の事実（issue #553、ADR-0009 決定 9）。開始と結果を別の表にするのは、
// append-only トリガーが UPDATE を拒否するため（1 行を後から埋められない）。
const attempts = "explainer_post_attempts";
const results = "explainer_post_attempt_results";

const statements = [
  `CREATE TABLE \`${attempts}\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`post_id\` integer NOT NULL,
	\`started_at\` text NOT NULL,
	FOREIGN KEY (\`post_id\`) REFERENCES \`explainer_posts\`(\`id\`) ON UPDATE no action ON DELETE no action
)`,
  ...appendOnlyTriggers(attempts),
  `CREATE TABLE \`${results}\` (
	\`attempt_id\` integer NOT NULL,
	\`outcome\` text NOT NULL CHECK (\`outcome\` IN ('succeeded', 'temporary', 'permanent')),
	\`remote_id\` text,
	\`recorded_at\` text NOT NULL,
	FOREIGN KEY (\`attempt_id\`) REFERENCES \`${attempts}\`(\`id\`) ON UPDATE no action ON DELETE no action
)`,
  ...appendOnlyTriggers(results),
];

export default applyStatements(statements);
