import { Clock, Effect, FileSystem, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { ChannelSettings } from "../channel/channel-settings.ts";
import { afterLatestFact } from "../db/fact-time.ts";
import {
  appendCandidate,
  appendSelection,
  latestSelectionAt,
  maxRound,
  requireSelectableCandidate,
  thumbnailKey,
} from "../db/explainer-thumbnails.ts";
import { requireLatestPlan } from "../db/explainer-videos.ts";
import { ThumbnailFiles } from "../thumbnails/thumbnail-files.ts";
import { processThumbnail } from "../thumbnails/thumbnail-image.ts";

class InvalidThumbnailCandidate extends Schema.TaggedError<InvalidThumbnailCandidate>()(
  "InvalidThumbnailCandidate",
  { candidate: Schema.String },
) {}

class ThumbnailChoiceRequired extends Schema.TaggedError<ThumbnailChoiceRequired>()(
  "ThumbnailChoiceRequired",
  {},
) {}

export interface SelectionRequest {
  /** `<回>-<番号>`。`file` とどちらか一方だけを渡す。 */
  readonly candidate: Option.Option<string>;
  /** 人間の画像のパス。`candidate` とどちらか一方だけを渡す。 */
  readonly file: Option.Option<string>;
  readonly videoId: string;
}

// 先頭が 0 の数・0・符号・桁区切りは受けない。
const candidatePattern = /^([1-9]\d*)-([1-9]\d*)$/u;

const toSafeInteger = (text: string | undefined) => {
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
};

const parseCandidate = (candidate: string) => {
  const [, roundText, numberText] = candidatePattern.exec(candidate) ?? [];
  const round = toSafeInteger(roundText);
  const number = toSafeInteger(numberText);
  return round === undefined || number === undefined
    ? Effect.fail(new InvalidThumbnailCandidate({ candidate }))
    : Effect.succeed({ number, round });
};

// 選択は、最後の選択と企画の更新のどちらよりも後の時刻で積む（選び直しで企画より新しい選択になる）。
const selectionTime = (videoId: string) =>
  Effect.gen(function* () {
    const plan = yield* requireLatestPlan(videoId);
    const lastSelection = yield* latestSelectionAt(videoId);
    const latest = Option.match(lastSelection, {
      onNone: () => plan.updatedAt,
      onSome: (selectedAt) => (selectedAt > plan.updatedAt ? selectedAt : plan.updatedAt),
    });
    return new Date(afterLatestFact(yield* Clock.currentTimeMillis, latest)).toISOString();
  });

const inTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(effect);
  }).pipe(Effect.catchTag("SqlError", Effect.die));

const selectExisting = (videoId: string, candidate: string) =>
  Effect.gen(function* () {
    const { number, round } = yield* parseCandidate(candidate);
    return yield* inTransaction(
      Effect.gen(function* () {
        const slot = { number, round, videoId };
        yield* requireLatestPlan(videoId);
        yield* requireSelectableCandidate(slot);
        yield* appendSelection({ ...slot, selectedAt: yield* selectionTime(videoId) });
        return slot;
      }),
    );
  });

// 検査と成果物の書き込みの後、候補の行と選択を 1 つのトランザクションで積む。
const selectHumanImage = (videoId: string, path: string) =>
  Effect.gen(function* () {
    yield* requireLatestPlan(videoId);
    const bytes = yield* (yield* FileSystem.FileSystem).readFile(path).pipe(Effect.orDie);
    const processed = yield* processThumbnail(bytes);
    const files = yield* ThumbnailFiles;
    return yield* inTransaction(
      Effect.gen(function* () {
        const slot = { number: 1, round: (yield* maxRound(videoId)) + 1, videoId };
        const key = thumbnailKey(videoId, slot.round, slot.number);
        yield* files.write(key, processed);
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* appendCandidate({ ...slot, createdAt: now, key, origin: "file" });
        yield* appendSelection({ ...slot, selectedAt: yield* selectionTime(videoId) });
        return slot;
      }),
    );
  });

const chooseOne = (request: SelectionRequest) =>
  Option.isSome(request.candidate) === Option.isSome(request.file)
    ? Effect.fail(new ThumbnailChoiceRequired())
    : Effect.succeed({ candidate: request.candidate, file: request.file });

/** サムネイルを 1 枚選ぶ。選んだ候補の動画 ID・回・番号・相対キーを返す。 */
export const selectThumbnail = (request: SelectionRequest) =>
  Effect.gen(function* () {
    yield* (yield* ChannelSettings).requireExplainer;
    const choice = yield* chooseOne(request);
    const selected = Option.isSome(choice.candidate)
      ? yield* selectExisting(request.videoId, choice.candidate.value)
      : yield* selectHumanImage(request.videoId, Option.getOrThrow(choice.file));
    return { ...selected, key: thumbnailKey(selected.videoId, selected.round, selected.number) };
  });
