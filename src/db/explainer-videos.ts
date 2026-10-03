import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

export class VideoNotFound extends Schema.TaggedError<VideoNotFound>()("VideoNotFound", {
  videoId: Schema.String,
}) {}

export class VideoIdCollision extends Schema.TaggedError<VideoIdCollision>()("VideoIdCollision", {
  videoId: Schema.String,
}) {}

// 出典は URL・記事タイトル・取得日時だけを持つ。記事の本文は持たない。
export const HttpUrl = Schema.String.check(
  Schema.makeFilter((value: string) => URL.canParse(value) && /^https?:/iu.test(value), {
    description: "an http(s) URL",
  }),
);
const Timestamp = Schema.String.check(
  Schema.makeFilter((value: string) => !Number.isNaN(Date.parse(value)), {
    description: "a date-time",
  }),
);
export const PlanSource = Schema.Struct({
  retrievedAt: Timestamp,
  title: Schema.String,
  url: HttpUrl,
});

/** 企画の内容。上書きのたびに版として積まれ、`updatedAt` はその版を積んだ時刻。 */
export const ExplainerPlan = Schema.Struct({
  hitPattern: Schema.String,
  points: Schema.Array(Schema.String),
  sources: Schema.Array(PlanSource),
  title: Schema.String,
  updatedAt: Schema.String,
});
export type ExplainerPlan = typeof ExplainerPlan.Type;
export type PlanContent = Omit<ExplainerPlan, "updatedAt">;

// points と sources は JSON の列。読み出すときに decode する。
const PlanRow = Schema.Struct({
  hit_pattern: Schema.String,
  points: Schema.fromJsonString(Schema.Array(Schema.String)),
  recorded_at: Schema.String,
  sources: Schema.fromJsonString(Schema.Array(PlanSource)),
  title: Schema.String,
});

const planFromRow = (row: typeof PlanRow.Type): ExplainerPlan => ({
  hitPattern: row.hit_pattern,
  points: row.points,
  sources: row.sources,
  title: row.title,
  updatedAt: row.recorded_at,
});

const findLatestPlan = (videoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: PlanRow,
      execute: (requested) =>
        sql`SELECT title, points, sources, hit_pattern, recorded_at FROM explainer_plans WHERE video_id = ${requested} ORDER BY recorded_at DESC, rowid DESC LIMIT 1`,
    });
    return Option.map(yield* find(videoId), planFromRow);
  }).pipe(Effect.orDie);

/** 動画の最後の版。動画は最初の版と同時にしか作られないので、版が無ければ動画も無い。 */
export const requireLatestPlan = (videoId: string) =>
  Effect.gen(function* () {
    const plan = yield* findLatestPlan(videoId);
    if (Option.isNone(plan)) {
      return yield* new VideoNotFound({ videoId });
    }
    return plan.value;
  });

// 別名 `plan` の行が、その動画の最後の版であること。冪等性の照合と題材候補の除外が同じ定義を使う。
const isLatestPlan = (sql: SqlClient.SqlClient) =>
  sql`plan.recorded_at = (SELECT max(recorded_at) FROM explainer_plans WHERE video_id = plan.video_id)`;

/** 各動画の最後の版が持つ冪等性のキーと一致する動画（最初に作られたもの）の ID。 */
const findVideoIdByLatestPlanKey = (planKey: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ video_id: Schema.String }),
      execute: (requested) =>
        sql`SELECT plan.video_id AS video_id FROM explainer_plans AS plan JOIN explainer_videos AS video ON video.id = plan.video_id WHERE plan.plan_key = ${requested} AND ${isLatestPlan(sql)} ORDER BY video.created_at, video.id LIMIT 1`,
    });
    return Option.map(yield* find(planKey), (row) => row.video_id);
  }).pipe(Effect.orDie);

interface PlanVersion {
  readonly content: PlanContent;
  readonly planKey: string;
  readonly recordedAt: string;
  readonly videoId: string;
}

/** 既存の動画に新しい版を積む。更新も削除もしない。 */
export const appendPlanVersion = (version: PlanVersion) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { content } = version;
    yield* sql`INSERT INTO explainer_plans (video_id, plan_key, title, points, sources, hit_pattern, recorded_at) VALUES (${version.videoId}, ${version.planKey}, ${content.title}, ${JSON.stringify(content.points)}, ${JSON.stringify(content.sources)}, ${content.hitPattern}, ${version.recordedAt})`;
  }).pipe(Effect.orDie);

interface NewVideo {
  readonly content: PlanContent;
  readonly nextVideoId: Effect.Effect<string>;
  readonly planKey: string;
  readonly recordedAt: string;
}

const findKeyedOrCreate = (video: NewVideo) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const existing = yield* findVideoIdByLatestPlanKey(video.planKey);
    if (Option.isSome(existing)) {
      return { created: false, videoId: existing.value };
    }
    const videoId = yield* video.nextVideoId;
    const taken = yield* sql`SELECT id FROM explainer_videos WHERE id = ${videoId} LIMIT 1`;
    if (taken.length > 0) {
      return yield* new VideoIdCollision({ videoId });
    }
    yield* sql`INSERT INTO explainer_videos (id, created_at) VALUES (${videoId}, ${video.recordedAt})`;
    yield* appendPlanVersion({ ...video, videoId });
    return { created: true, videoId };
  });

/**
 * 最後の版が同じ冪等性のキーを持つ動画があればその ID を返し、無ければ動画と最初の版を積む。
 * 照合と挿入は 1 つのトランザクションで行うので、同じ主出典の同時の呼び出しが別々の動画を作らない。
 * 生成した ID が既存の行と衝突したら何も書かない。
 */
export const recordPlanOnce = (video: NewVideo) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(findKeyedOrCreate(video));
  }).pipe(Effect.catchTag("SqlError", Effect.die));

/** 各動画の最後の版が持つ冪等性のキー。キーの形式は解釈しない。 */
export const listLatestPlanKeys = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ plan_key: Schema.String }),
    execute: () =>
      sql`SELECT DISTINCT plan.plan_key AS plan_key FROM explainer_plans AS plan WHERE ${isLatestPlan(sql)}`,
  });
  return (yield* findAll(undefined)).map((row) => row.plan_key);
}).pipe(Effect.orDie);
