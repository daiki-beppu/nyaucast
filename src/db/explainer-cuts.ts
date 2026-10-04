import { Clock, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { afterLatestFact } from "./fact-time.ts";
import { insertRow, queryRows } from "./explainer-thumbnails.ts";

/** 長尺のカットの名前。ショートのカットは `short-<n>-clip` と `short-<n>-dedicated`（`videos/cuts.ts` が名前を解決する）。 */
export const longCut = "long";

const CutExport = Schema.Struct({
  compositionHash: Schema.String,
  createdAt: Schema.String,
  key: Schema.String,
  renderHash: Schema.String,
});
type CutExport = typeof CutExport.Type;

const CutPreview = Schema.Struct({
  compositionHash: Schema.String,
  createdAt: Schema.String,
});
type CutPreview = typeof CutPreview.Type;

/** read model が返すカットの事実。書き出しやプレビューが無ければ、そのキーが無い。 */
export const CutFacts = Schema.Struct({
  cut: Schema.String,
  lastExport: Schema.optionalKey(CutExport),
  lastPreview: Schema.optionalKey(CutPreview),
});

const ExportRow = Schema.Struct({
  composition_hash: Schema.String,
  created_at: Schema.String,
  key: Schema.String,
  render_hash: Schema.String,
});
const PreviewRow = Schema.Struct({ composition_hash: Schema.String, created_at: Schema.String });
const CutRow = Schema.Struct({ cut: Schema.String });

// 事実の表。行を読む schema と、read model の形への変換を、表ごとに 1 か所で持つ。
interface FactTable<Row, Fact extends { readonly createdAt: string }> {
  readonly name: "explainer_cut_exports" | "explainer_cut_previews";
  readonly Row: Schema.Decoder<Row>;
  readonly toFact: (row: Row) => Fact;
}

const exportsTable: FactTable<typeof ExportRow.Type, CutExport> = {
  name: "explainer_cut_exports",
  Row: ExportRow,
  toFact: (row) => ({
    compositionHash: row.composition_hash,
    createdAt: row.created_at,
    key: row.key,
    renderHash: row.render_hash,
  }),
};

const previewsTable: FactTable<typeof PreviewRow.Type, CutPreview> = {
  name: "explainer_cut_previews",
  Row: PreviewRow,
  toFact: (row) => ({ compositionHash: row.composition_hash, createdAt: row.created_at }),
};

// 最後の行は、時刻の新しいもの。同時刻なら後から積まれたもの。
const lastFact = <Row, Fact extends { readonly createdAt: string }>(
  table: FactTable<Row, Fact>,
  videoId: string,
  cut: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* queryRows(
      table.Row,
      sql`SELECT * FROM ${sql(table.name)} WHERE video_id = ${videoId} AND cut = ${cut} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    );
    return Option.map(Option.fromNullishOr(rows[0]), table.toFact);
  });

export const lastCutExport = (videoId: string, cut: string) => lastFact(exportsTable, videoId, cut);

export const lastCutPreview = (videoId: string, cut: string) =>
  lastFact(previewsTable, videoId, cut);

const laterOf = (a: string | undefined, b: string | undefined) =>
  a === undefined || (b !== undefined && b > a) ? b : a;

// 新しい行は、同じカットの直前の行と、after（ショートの候補の最後の版の時刻）より必ず後の時刻で積む。
const appendFact = <Row, Fact extends { readonly createdAt: string }>(
  table: FactTable<Row, Fact>,
  scope: { readonly after?: string | undefined; readonly cut: string; readonly videoId: string },
  columns: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const latest = yield* lastFact(table, scope.videoId, scope.cut);
    const now = yield* Clock.currentTimeMillis;
    yield* insertRow(table.name, {
      ...columns,
      created_at: new Date(
        afterLatestFact(now, laterOf(Option.getOrUndefined(latest)?.createdAt, scope.after)),
      ).toISOString(),
      cut: scope.cut,
      video_id: scope.videoId,
    });
  });

export const appendCutExport = (fact: {
  readonly after?: string | undefined;
  readonly compositionHash: string;
  readonly cut: string;
  readonly key: string;
  readonly renderHash: string;
  readonly videoId: string;
}) =>
  appendFact(exportsTable, fact, {
    composition_hash: fact.compositionHash,
    key: fact.key,
    render_hash: fact.renderHash,
  });

export const appendCutPreview = (fact: {
  readonly compositionHash: string;
  readonly cut: string;
  readonly videoId: string;
}) =>
  appendFact(previewsTable, fact, {
    composition_hash: fact.compositionHash,
  });

const cutFactsOf = (videoId: string, cut: string) =>
  Effect.all([lastCutExport(videoId, cut), lastCutPreview(videoId, cut)]).pipe(
    Effect.map(([lastExport, lastPreview]): typeof CutFacts.Type => ({
      cut,
      ...(Option.isSome(lastExport) ? { lastExport: lastExport.value } : {}),
      ...(Option.isSome(lastPreview) ? { lastPreview: lastPreview.value } : {}),
    })),
  );

/** 事実のあるカットを、名前の昇順に。カットごとに最後の書き出しと最後のプレビューを持つ。 */
export const readCutFacts = (videoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cuts = yield* queryRows(
      CutRow,
      sql`SELECT cut FROM explainer_cut_exports WHERE video_id = ${videoId} UNION SELECT cut FROM explainer_cut_previews WHERE video_id = ${videoId} ORDER BY cut`,
    );
    return yield* Effect.forEach(cuts, (row) => cutFactsOf(videoId, row.cut));
  });
