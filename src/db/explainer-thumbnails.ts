import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

export class ThumbnailCandidateNotFound extends Schema.TaggedError<ThumbnailCandidateNotFound>()(
  "ThumbnailCandidateNotFound",
  { number: Schema.Finite, round: Schema.Finite, videoId: Schema.String },
) {}

class ThumbnailCandidateExcluded extends Schema.TaggedError<ThumbnailCandidateExcluded>()(
  "ThumbnailCandidateExcluded",
  { number: Schema.Finite, round: Schema.Finite, videoId: Schema.String },
) {}

const Origin = Schema.Literals(["file", "generated"]);
export type ThumbnailOrigin = typeof Origin.Type;

/** 候補の相対キー。縮小版のキーは、本体のキーの拡張子の前に `.small` を足したもの。 */
export const thumbnailKey = (videoId: string, round: number, number: number) =>
  `videos/${videoId}/thumbnails/${round}-${number}.jpg`;
export const smallThumbnailKey = (key: string) => key.replace(/\.jpg$/u, ".small.jpg");

export const ThumbnailCandidate = Schema.Struct({
  createdAt: Schema.String,
  key: Schema.String,
  number: Schema.Finite,
  origin: Origin,
  round: Schema.Finite,
  smallKey: Schema.String,
});
type ThumbnailCandidate = typeof ThumbnailCandidate.Type;

export const ThumbnailExclusion = Schema.Struct({
  excludedAt: Schema.String,
  number: Schema.Finite,
  reason: Schema.String,
  round: Schema.Finite,
});
type ThumbnailExclusion = typeof ThumbnailExclusion.Type;

const ThumbnailSelection = Schema.Struct({
  key: Schema.String,
  number: Schema.Finite,
  round: Schema.Finite,
  selectedAt: Schema.String,
});

/** read model が返すサムネイルの事実。選択が無ければ selection のキーが無い。 */
export const ThumbnailFacts = Schema.Struct({
  candidates: Schema.Array(ThumbnailCandidate),
  exclusions: Schema.Array(ThumbnailExclusion),
  selection: Schema.optionalKey(ThumbnailSelection),
});

const CandidateRow = Schema.Struct({
  created_at: Schema.String,
  key: Schema.String,
  number: Schema.Finite,
  origin: Origin,
  round: Schema.Finite,
});
const ExclusionRow = Schema.Struct({
  excluded_at: Schema.String,
  number: Schema.Finite,
  reason: Schema.String,
  round: Schema.Finite,
});
const SelectionRow = Schema.Struct({
  key: Schema.String,
  number: Schema.Finite,
  round: Schema.Finite,
  selected_at: Schema.String,
});
const Count = Schema.Struct({ n: Schema.Finite });

export interface CandidateRef {
  readonly number: number;
  readonly round: number;
  readonly videoId: string;
}

// 行を schema で decode する。SqlError は想定外の失敗として defect にする。
export const queryRows = <A>(
  Row: Schema.Decoder<A>,
  statement: Effect.Effect<ReadonlyArray<unknown>, unknown>,
) => statement.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))), Effect.orDie);

export const insertRow = (table: string, row: Record<string, number | string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO ${sql(table)} ${sql.insert(row)}`;
  }).pipe(Effect.orDie);

const listCandidates = (videoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* queryRows(
      CandidateRow,
      sql`SELECT round, number, key, origin, created_at FROM explainer_thumbnail_candidates WHERE video_id = ${videoId} ORDER BY round, number`,
    );
    return rows.map((row): ThumbnailCandidate => ({
      createdAt: row.created_at,
      key: row.key,
      number: row.number,
      origin: row.origin,
      round: row.round,
      smallKey: smallThumbnailKey(row.key),
    }));
  });

const toExclusion = (row: typeof ExclusionRow.Type): ThumbnailExclusion => ({
  excludedAt: row.excluded_at,
  number: row.number,
  reason: row.reason,
  round: row.round,
});

const listExclusions = (videoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* queryRows(
      ExclusionRow,
      sql`SELECT round, number, reason, excluded_at FROM explainer_thumbnail_exclusions WHERE video_id = ${videoId} ORDER BY rowid`,
    );
    return rows.map(toExclusion);
  });

// 最後の選択は、時刻の新しいもの。同時刻なら後から積まれたもの。
const lastSelection = (videoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* queryRows(
      SelectionRow,
      sql`SELECT selection.round AS round, selection.number AS number, candidate.key AS key, selection.selected_at AS selected_at FROM explainer_thumbnail_selections AS selection JOIN explainer_thumbnail_candidates AS candidate ON candidate.video_id = selection.video_id AND candidate.round = selection.round AND candidate.number = selection.number WHERE selection.video_id = ${videoId} ORDER BY selection.selected_at DESC, selection.rowid DESC LIMIT 1`,
    );
    return Option.map(Option.fromNullishOr(rows[0]), (row) => ({
      key: row.key,
      number: row.number,
      round: row.round,
      selectedAt: row.selected_at,
    }));
  });

export const readThumbnailFacts = (videoId: string) =>
  Effect.gen(function* () {
    const [candidates, exclusions, selection] = yield* Effect.all(
      [listCandidates(videoId), listExclusions(videoId), lastSelection(videoId)],
      { concurrency: "unbounded" },
    );
    return {
      candidates,
      exclusions,
      ...(Option.isSome(selection) ? { selection: selection.value } : {}),
    } satisfies typeof ThumbnailFacts.Type;
  });

/** 最後の選択の時刻。新しい選択は、これより後の時刻で積む。 */
export const latestSelectionAt = (videoId: string) =>
  lastSelection(videoId).pipe(Effect.map(Option.map((selection) => selection.selectedAt)));

const queryCount = (statement: Effect.Effect<ReadonlyArray<unknown>, unknown>) =>
  queryRows(Count, statement).pipe(Effect.map((rows) => rows[0]?.n ?? 0));

/** 動画の、出所を問わない最大の回（検査に落ちた生成の回を含む）。回が無ければ 0。 */
export const maxRound = (videoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* queryCount(
      sql`SELECT coalesce(max(round), 0) AS n FROM (SELECT round FROM explainer_thumbnail_candidates WHERE video_id = ${videoId} UNION ALL SELECT round FROM explainer_thumbnail_rejections WHERE video_id = ${videoId})`,
    );
  });

/** 動画の、出所が生成の最大の回（検査に落ちた生成だけの回を含む）。無ければ None。 */
export const latestGeneratedRound = (videoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const n = yield* queryCount(
      sql`SELECT coalesce(max(round), 0) AS n FROM (SELECT round FROM explainer_thumbnail_candidates WHERE video_id = ${videoId} AND origin = 'generated' UNION ALL SELECT round FROM explainer_thumbnail_rejections WHERE video_id = ${videoId})`,
    );
    return n === 0 ? Option.none<number>() : Option.some(n);
  });

/** 回で生成を済ませた番号（候補があるか、検査に落ちた記録がある）。 */
export const numbersInRound = (videoId: string, round: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* queryRows(
      Schema.Struct({ number: Schema.Finite }),
      sql`SELECT number FROM explainer_thumbnail_candidates WHERE video_id = ${videoId} AND round = ${round} UNION SELECT number FROM explainer_thumbnail_rejections WHERE video_id = ${videoId} AND round = ${round} ORDER BY number`,
    );
    return rows.map((row) => row.number);
  });

/** チャンネル全体の生成の回数（出所が生成の候補と、検査に落ちた生成の行数）。参照画像を回す位置の元になる。 */
export const generationCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* queryCount(
    sql`SELECT (SELECT count(*) FROM explainer_thumbnail_candidates WHERE origin = 'generated') + (SELECT count(*) FROM explainer_thumbnail_rejections) AS n`,
  );
});

export const appendCandidate = (candidate: {
  readonly createdAt: string;
  readonly key: string;
  readonly number: number;
  readonly origin: ThumbnailOrigin;
  readonly round: number;
  readonly videoId: string;
}) =>
  insertRow("explainer_thumbnail_candidates", {
    created_at: candidate.createdAt,
    key: candidate.key,
    number: candidate.number,
    origin: candidate.origin,
    round: candidate.round,
    video_id: candidate.videoId,
  });

/** 生成には成功したが検査に落ちた画像の事実。参照画像は、使ったときだけ宣言のパスを持つ。 */
export const appendRejection = (
  rejection: CandidateRef & {
    readonly reason: string;
    readonly referenceImage?: string;
    readonly rejectedAt: string;
  },
) =>
  insertRow("explainer_thumbnail_rejections", {
    number: rejection.number,
    reason: rejection.reason,
    ...(rejection.referenceImage === undefined
      ? {}
      : { reference_image: rejection.referenceImage }),
    rejected_at: rejection.rejectedAt,
    round: rejection.round,
    video_id: rejection.videoId,
  });

/** 候補が無ければ ThumbnailCandidateNotFound。 */
export const requireCandidate = (ref: CandidateRef) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const count = yield* queryCount(
      sql`SELECT count(*) AS n FROM explainer_thumbnail_candidates WHERE video_id = ${ref.videoId} AND round = ${ref.round} AND number = ${ref.number}`,
    );
    if (count === 0) {
      return yield* new ThumbnailCandidateNotFound({ ...ref });
    }
  });

/** 候補の最初の除外。除外が無ければ None。 */
export const findExclusion = (ref: CandidateRef) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* queryRows(
      ExclusionRow,
      sql`SELECT round, number, reason, excluded_at FROM explainer_thumbnail_exclusions WHERE video_id = ${ref.videoId} AND round = ${ref.round} AND number = ${ref.number} ORDER BY rowid LIMIT 1`,
    );
    return Option.map(Option.fromNullishOr(rows[0]), toExclusion);
  });

export const appendExclusion = (exclusion: CandidateRef & { excludedAt: string; reason: string }) =>
  insertRow("explainer_thumbnail_exclusions", {
    excluded_at: exclusion.excludedAt,
    number: exclusion.number,
    reason: exclusion.reason,
    round: exclusion.round,
    video_id: exclusion.videoId,
  });

/** 選べる候補（あって、除外されていない）。選べなければ型付きの失敗。 */
export const requireSelectableCandidate = (ref: CandidateRef) =>
  Effect.gen(function* () {
    yield* requireCandidate(ref);
    if (Option.isSome(yield* findExclusion(ref))) {
      return yield* new ThumbnailCandidateExcluded({ ...ref });
    }
  });

export const appendSelection = (selection: CandidateRef & { selectedAt: string }) =>
  insertRow("explainer_thumbnail_selections", {
    number: selection.number,
    round: selection.round,
    selected_at: selection.selectedAt,
    video_id: selection.videoId,
  });
