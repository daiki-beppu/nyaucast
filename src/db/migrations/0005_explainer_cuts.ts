import { appendOnlyTriggers, applyStatements } from "./append-only.ts";

// カットの書き出しとプレビューの事実。実際に作ったときだけ積み、既存を返したときは積まない（ADR-0009 決定 11）。
// カットの名前には CHECK を付けない（ショートのカットの名前を後から足せるようにする）。
const exportsTable = "explainer_cut_exports";
const previews = "explainer_cut_previews";

const statements = [
  `CREATE TABLE \`${exportsTable}\` (
	\`video_id\` text NOT NULL,
	\`cut\` text NOT NULL,
	\`key\` text NOT NULL,
	\`composition_hash\` text NOT NULL,
	\`render_hash\` text NOT NULL,
	\`created_at\` text NOT NULL,
	FOREIGN KEY (\`video_id\`) REFERENCES \`explainer_videos\`(\`id\`) ON UPDATE no action ON DELETE no action
)`,
  ...appendOnlyTriggers(exportsTable),
  `CREATE TABLE \`${previews}\` (
	\`video_id\` text NOT NULL,
	\`cut\` text NOT NULL,
	\`composition_hash\` text NOT NULL,
	\`created_at\` text NOT NULL,
	FOREIGN KEY (\`video_id\`) REFERENCES \`explainer_videos\`(\`id\`) ON UPDATE no action ON DELETE no action
)`,
  ...appendOnlyTriggers(previews),
];

export default applyStatements(statements);
