import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// 呼び出し側は戻り値の形を構造的に受け取るだけで、この型名を import しない。
type CommandOutput = { readonly exitCode: number; readonly stdout: string };

/**
 * `spawner` で外部コマンドを 1 回起こし、終了コードと標準出力をまとめて返す。stdin へは何も書かない。
 * 標準出力の収集と終了コードの待機を同時に行う（順に待つとデッドロックしうる。`src/auth/secrets.ts` の
 * 旧実装の先例）。
 */
export const runCommand = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  options?: { readonly env?: Record<string, string> },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      // env を渡すときは、それが子プロセスの環境の全体になる（呼び出し側がすでに親の環境を
      // 組み込んでいる前提。重ねて埋め合わせない）。env を渡さないときは、子プロセスは親プロセスの
      // 環境をそのまま継承する（`src/auth/secrets.ts` の `op read` はこちら）。
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          command,
          args,
          options?.env === undefined ? undefined : { env: options.env },
        ),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { exitCode, stdout } satisfies CommandOutput;
    }),
  );
