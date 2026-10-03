import { appendOnlyTriggers, applyStatements } from "./append-only.ts";

// サムネイルの事実の表。候補・除外・選択はどれも積むだけで、進捗の列は持たない。
const factTable = (table: string, columns: string, constraints = "") =>
  `CREATE TABLE \`${table}\` (
	\`video_id\` text NOT NULL,
	\`round\` integer NOT NULL,
	\`number\` integer NOT NULL,
	${columns},
	FOREIGN KEY (\`video_id\`) REFERENCES \`explainer_videos\`(\`id\`) ON UPDATE no action ON DELETE no action${constraints}
)`;

const tables = [
  "explainer_thumbnail_candidates",
  "explainer_thumbnail_exclusions",
  "explainer_thumbnail_selections",
];

const statements = [
  factTable(
    "explainer_thumbnail_candidates",
    "`key` text NOT NULL,\n\t`origin` text NOT NULL,\n\t`created_at` text NOT NULL",
    `,\n\tCONSTRAINT "explainer_thumbnail_candidates_origin" CHECK("explainer_thumbnail_candidates"."origin" IN ('generated', 'file')),\n\tCONSTRAINT "explainer_thumbnail_candidates_unique" UNIQUE(\`video_id\`, \`round\`, \`number\`)`,
  ),
  factTable(
    "explainer_thumbnail_exclusions",
    "`reason` text NOT NULL,\n\t`excluded_at` text NOT NULL",
  ),
  factTable("explainer_thumbnail_selections", "`selected_at` text NOT NULL"),
  ...tables.flatMap(appendOnlyTriggers),
];

export default applyStatements(statements);
