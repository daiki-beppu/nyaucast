import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { ChannelSettings } from "../channel/channel-settings.ts";
import {
  abandonCollection,
  produceCollection,
  publishCollection,
} from "../collections/gate-operations.ts";
import { abandonVideo, produceVideo } from "./gate-operations.ts";
import { publishExplainerVideo } from "./publish-dialog.ts";
import { selectThumbnail } from "./thumbnail-selection.ts";

const description = [
  "サムネイルを 1 枚選ぶ。",
  "  nyaucast video thumbnail <id> <回>-<番号>   生成した候補（例: 2-1）を選ぶ。除外した候補は選べない",
  "  nyaucast video thumbnail <id> --file <パス> 人間の画像を同じ検査に通して候補に足し、同時に選ぶ",
].join("\n");

const thumbnail = Command.make(
  "thumbnail",
  {
    // 位置引数は宣言の順に読まれる。id が先。
    id: Argument.String("id"),
    candidate: Argument.String("candidate").pipe(Argument.optional),
    file: Flag.File("file", { mustExist: true }).pipe(Flag.optional),
  },
  ({ candidate, file, id }) =>
    selectThumbnail({ candidate, file, videoId: id }).pipe(
      Effect.flatMap((selected) =>
        Console.log(
          `選択しました: ${selected.videoId} ${selected.round}-${selected.number} ${selected.key}`,
        ),
      ),
    ),
).pipe(Command.withDescription(description));

interface GateResult {
  readonly gate: string;
  readonly recorded: boolean;
  readonly videoId: string;
}

interface GateMessages {
  readonly already: string;
  readonly recorded: string;
}

// 出力は事実の 1 行だけ。積んだか、既にそうだったかを分ける。
const logGateResult = (messages: GateMessages) => (result: GateResult) =>
  Console.log(
    result.recorded
      ? `${messages.recorded}: video ${result.videoId} / gate=${result.gate}`
      : `${messages.already}: video ${result.videoId} / gate=${result.gate}（記録は追加していません）`,
  );

const gateCommand = <E, R>(
  name: string,
  description: string,
  operation: (id: string) => Effect.Effect<GateResult, E, R>,
  messages: GateMessages,
) =>
  Command.make(name, { id: Argument.String("id") }, ({ id }) =>
    operation(id).pipe(Effect.flatMap(logGateResult(messages))),
  ).pipe(Command.withDescription(description));

// どちらの動画のゲートを操作するかは、チャンネルの種類が決める。種類は呼び出しのたびに設定から読む。
const byChannelKind =
  <E1, R1, E2, R2>(operations: {
    readonly collection: (
      id: string,
    ) => Effect.Effect<
      { readonly collectionId: string; readonly gate: string; readonly recorded: boolean },
      E1,
      R1
    >;
    readonly explainer: (id: string) => Effect.Effect<GateResult, E2, R2>;
  }) =>
  (id: string) =>
    Effect.gen(function* () {
      if ((yield* (yield* ChannelSettings).kind) === "explainer") {
        return yield* operations.explainer(id);
      }
      const { collectionId, gate, recorded } = yield* operations.collection(id);
      return { gate, recorded, videoId: collectionId } satisfies GateResult;
    });

const produce = gateCommand(
  "produce",
  "企画ゲートを承認する。やめた動画はこの承認で再開する",
  byChannelKind({ collection: produceCollection, explainer: produceVideo }),
  { already: "既に承認済みです", recorded: "承認を記録しました" },
);

const publishMessages = { already: "既に承認済みです", recorded: "承認を記録しました" };

// BGM 動画は承認を書くだけ。解説動画は stdin が TTY のときだけ、対話で承認と投稿を書く。
const publish = Command.make("publish", { id: Argument.String("id") }, ({ id }) =>
  Effect.gen(function* () {
    if ((yield* (yield* ChannelSettings).kind) === "explainer") {
      return yield* publishExplainerVideo(id);
    }
    const { collectionId, gate, recorded } = yield* publishCollection(id);
    return yield* logGateResult(publishMessages)({ gate, recorded, videoId: collectionId });
  }),
).pipe(
  Command.withDescription(
    "公開ゲートを承認する。企画ゲートの承認が前提。解説動画は TTY で投稿案を見て、承認と同時に投稿を作る",
  ),
);

const abandon = gateCommand(
  "abandon",
  "動画をやめる。公開ゲートを承認した動画はやめられない",
  byChannelKind({ collection: abandonCollection, explainer: abandonVideo }),
  { already: "既にやめています", recorded: "NO-GO を記録しました" },
);

export const videoCommand = Command.make("video").pipe(
  Command.withSubcommands([thumbnail, produce, publish, abandon]),
);
