import { appendOnlyTriggers, applyStatements } from "./append-only.ts";

// 生成には成功したが検査に落ちた画像の事実。1 回の課金ごとに積み、再実行で同じ番号を払い直さない（ADR-0009 決定 11・14）。
const table = "explainer_thumbnail_rejections";

const statements = [
  `CREATE TABLE \`${table}\` (
	\`video_id\` text NOT NULL,
	\`round\` integer NOT NULL,
	\`number\` integer NOT NULL,
	\`reason\` text NOT NULL,
	\`reference_image\` text,
	\`rejected_at\` text NOT NULL,
	FOREIGN KEY (\`video_id\`) REFERENCES \`explainer_videos\`(\`id\`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "${table}_reason" CHECK("${table}"."reason" IN ('unreadable', 'too_small', 'not_16_9', 'too_large')),
	CONSTRAINT "${table}_unique" UNIQUE(\`video_id\`, \`round\`, \`number\`)
)`,
  ...appendOnlyTriggers(table),
];

export default applyStatements(statements);
