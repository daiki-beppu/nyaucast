import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { abandonVideo, produceVideo } from "./gate-operations.ts";
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

// 出力は事実の 1 行だけ。積んだか、既にそうだったかを分ける。
const gateCommand = <E, R>(
  name: string,
  description: string,
  operation: (
    id: string,
  ) => Effect.Effect<
    { readonly gate: string; readonly recorded: boolean; readonly videoId: string },
    E,
    R
  >,
  messages: { readonly already: string; readonly recorded: string },
) =>
  Command.make(name, { id: Argument.String("id") }, ({ id }) =>
    operation(id).pipe(
      Effect.flatMap((result) =>
        Console.log(
          result.recorded
            ? `${messages.recorded}: video ${result.videoId} / gate=${result.gate}`
            : `${messages.already}: video ${result.videoId} / gate=${result.gate}（記録は追加していません）`,
        ),
      ),
    ),
  ).pipe(Command.withDescription(description));

const produce = gateCommand(
  "produce",
  "企画ゲートを承認する。やめた動画はこの承認で再開する",
  produceVideo,
  { already: "既に承認済みです", recorded: "承認を記録しました" },
);

const abandon = gateCommand(
  "abandon",
  "動画をやめる。公開ゲートを承認した動画はやめられない",
  abandonVideo,
  { already: "既にやめています", recorded: "NO-GO を記録しました" },
);

export const videoCommand = Command.make("video").pipe(
  Command.withSubcommands([thumbnail, produce, abandon]),
);
