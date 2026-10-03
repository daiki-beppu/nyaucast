import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";

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

export const videoCommand = Command.make("video").pipe(Command.withSubcommands([thumbnail]));
