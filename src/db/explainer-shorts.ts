import { Clock, Effect, Option, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";

import { ParagraphRange } from "../shorts/short-candidate.ts";
import { afterLatestFact } from "./fact-time.ts";
import { insertRow, queryRows } from "./explainer-thumbnails.ts";

export class ShortCandidateNotFound extends Schema.TaggedError<ShortCandidateNotFound>()(
  "ShortCandidateNotFound",
  { number: Schema.Finite, videoId: Schema.String },
) {}

/** read model が返すショートの候補（最後の版）。 */
export const ShortCandidate = Schema.Struct({
  createdAt: Schema.String,
  hook: Schema.String,
  number: Schema.Finite,
  range: ParagraphRange,
  scriptKey: Schema.String,
});
export type ShortCandidate = typeof ShortCandidate.Type;

/** 版そのもの。read model の候補に、台本の内容のハッシュ（書き直しが変更かどうかの判定用）を足したもの。 */
export interface ShortVersion extends ShortCandidate {
  readonly scriptSha256: string;
}

const VersionRow = Schema.Struct({
  created_at: Schema.String,
  end_paragraph: Schema.Finite,
  end_scene: Schema.Finite,
  hook: Schema.String,
  number: Schema.Finite,
  script_key: Schema.String,
  script_sha256: Schema.String,
  start_paragraph: Schema.Finite,
  start_scene: Schema.Finite,
});
const WithdrawalRow = Schema.Struct({ withdrawn_at: Schema.String });
const LatestRow = Schema.Struct({ latest: Schema.NullOr(Schema.String) });
const NumberRow = Schema.Struct({ number: Schema.Finite });

const versionOf = (row: typeof VersionRow.Type): ShortVersion => ({
  createdAt: row.created_at,
  hook: row.hook,
  number: row.number,
  range: {
    end: { paragraph: row.end_paragraph, scene: row.end_scene },
    start: { paragraph: row.start_paragraph, scene: row.start_scene },
  },
  scriptKey: row.script_key,
  scriptSha256: row.script_sha256,
});

const candidateOf = ({ scriptSha256: _scriptSha256, ...candidate }: ShortVersion): ShortCandidate =>
  candidate;

/** 同じ番号の最後の版（取り下げられていても返す）。時刻の新しいもの、同時刻なら後から積まれたもの。 */
export const lastShortVersion = (videoId: string, number: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* queryRows(
      VersionRow,
      sql`SELECT * FROM explainer_short_versions WHERE video_id = ${videoId} AND number = ${number} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    );
    return Option.map(Option.fromNullishOr(rows[0]), versionOf);
  });

/** 最後の取り下げが、版より新しいか。取り下げた後に版が積まれれば、候補に戻る。 */
export const isWithdrawn = (videoId: string, version: ShortCandidate) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* queryRows(
      WithdrawalRow,
      sql`SELECT withdrawn_at FROM explainer_short_withdrawals WHERE video_id = ${videoId} AND number = ${version.number} ORDER BY withdrawn_at DESC, rowid DESC LIMIT 1`,
    );
    return (rows[0]?.withdrawn_at ?? "") > version.createdAt;
  });

/** 取り下げていない候補の最後の版。無い・取り下げ済みなら ShortCandidateNotFound。 */
export const requireActiveShort = (videoId: string, number: number) =>
  Effect.gen(function* () {
    const version = yield* lastShortVersion(videoId, number);
    if (Option.isNone(version) || (yield* isWithdrawn(videoId, version.value))) {
      return yield* new ShortCandidateNotFound({ number, videoId });
    }
    return candidateOf(version.value);
  });

// 同じ番号の直前の事実（版と取り下げの両方）より必ず後の時刻。
const nextFactTime = (videoId: string, number: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* queryRows(
      LatestRow,
      sql`SELECT max(at) AS latest FROM (SELECT created_at AS at FROM explainer_short_versions WHERE video_id = ${videoId} AND number = ${number} UNION ALL SELECT withdrawn_at AS at FROM explainer_short_withdrawals WHERE video_id = ${videoId} AND number = ${number})`,
    );
    const now = yield* Clock.currentTimeMillis;
    return new Date(afterLatestFact(now, rows[0]?.latest ?? undefined)).toISOString();
  });

export interface NewShortVersion {
  readonly hook: string;
  readonly number: number;
  readonly range: ParagraphRange;
  readonly scriptKey: string;
  readonly scriptSha256: string;
  readonly videoId: string;
}

export const appendShortVersion = (version: NewShortVersion) =>
  Effect.gen(function* () {
    yield* insertRow("explainer_short_versions", {
      created_at: yield* nextFactTime(version.videoId, version.number),
      end_paragraph: version.range.end.paragraph,
      end_scene: version.range.end.scene,
      hook: version.hook,
      number: version.number,
      script_key: version.scriptKey,
      script_sha256: version.scriptSha256,
      start_paragraph: version.range.start.paragraph,
      start_scene: version.range.start.scene,
      video_id: version.videoId,
    });
  });

export const appendShortWithdrawal = (videoId: string, number: number) =>
  Effect.gen(function* () {
    yield* insertRow("explainer_short_withdrawals", {
      number,
      video_id: videoId,
      withdrawn_at: yield* nextFactTime(videoId, number),
    });
  });

const activeShort = (videoId: string, number: number) =>
  requireActiveShort(videoId, number).pipe(
    Effect.map(Option.some),
    Effect.catchTag("ShortCandidateNotFound", () => Effect.succeed(Option.none<ShortCandidate>())),
  );

/** 取り下げていない候補を、番号の昇順に。それぞれ最後の版。 */
export const readShortFacts = (videoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const numbers = yield* queryRows(
      NumberRow,
      sql`SELECT DISTINCT number FROM explainer_short_versions WHERE video_id = ${videoId} ORDER BY number`,
    );
    const candidates = yield* Effect.forEach(numbers, (row) => activeShort(videoId, row.number));
    return candidates.flatMap((candidate) => Option.toArray(candidate));
  });

/** 版と取り下げの時刻は直前の事実より後にするので、候補の事実を積む操作はこの 1 本で直列にして順序を守る。 */
export const shortFactLock = Semaphore.makeUnsafe(1);
