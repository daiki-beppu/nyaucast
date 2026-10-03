import { Context, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// この adapter は動画の種類を知らず、プロンプトと参照画像だけを受ける。
// codex には画像の生成だけをさせる。成否は終了コードと出力ファイルの有無で決め、codex の出力は読まない。
// ログイン状態は codex 自身が管理する。ここでは `codex login status` の終了コードで確かめるだけで、認証情報には触れない。
const outputFileName = "thumbnail.png";

// 固定の定型文。tool が組み立てたプロンプトの前に付ける。
const instructionPreamble = (referenceFileName: string | undefined) =>
  [
    `Use the built-in image generation to create exactly one 16:9 image and save it as a PNG at ./${outputFileName} in the working directory.`,
    ...(referenceFileName === undefined
      ? []
      : [`Use the attached image ./${referenceFileName} as a style reference.`]),
    "Do not write any other file and do not return any text or judgement.",
    "Image brief:",
  ].join("\n");

// 失敗は、タグと事実（終了コード）だけを持つ。
export class CodexNotLoggedIn extends Schema.TaggedError<CodexNotLoggedIn>()(
  "CodexNotLoggedIn",
  {},
) {}
export class CodexUnavailable extends Schema.TaggedError<CodexUnavailable>()(
  "CodexUnavailable",
  {},
) {}
export class CodexExecFailed extends Schema.TaggedError<CodexExecFailed>()("CodexExecFailed", {
  exitCode: Schema.Finite,
}) {}
export class CodexImageMissing extends Schema.TaggedError<CodexImageMissing>()(
  "CodexImageMissing",
  {},
) {}

interface GeneratedImage {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

interface GenerateRequest {
  readonly prompt: string;
  readonly referenceImage?: { readonly bytes: Uint8Array; readonly mimeType: string };
}

/** codex CLI の画像生成。課金される呼び出しなので、失敗を再試行しない。 */
export class CodexImageGenerator extends Context.Service<
  CodexImageGenerator,
  {
    readonly requireLogin: Effect.Effect<void, CodexNotLoggedIn | CodexUnavailable>;
    generate(
      request: GenerateRequest,
    ): Effect.Effect<GeneratedImage, CodexExecFailed | CodexImageMissing | CodexUnavailable>;
  }
>()("nyaucast/CodexImageGenerator") {
  static readonly layer = Layer.effect(
    CodexImageGenerator,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // 標準出力と標準エラーは、パイプが詰まらないよう終了コードと並行して最後まで読み捨てる。
      const run = (args: readonly string[]) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make("codex", args, { stdin: "ignore" }),
            );
            const [, , exitCode] = yield* Effect.all(
              [Stream.runDrain(handle.stdout), Stream.runDrain(handle.stderr), handle.exitCode],
              { concurrency: "unbounded" },
            );
            return exitCode;
          }),
        ).pipe(Effect.mapError(() => new CodexUnavailable()));

      const requireLogin = Effect.gen(function* () {
        const exitCode = yield* run(["login", "status"]);
        if (exitCode !== 0) {
          return yield* new CodexNotLoggedIn();
        }
      });

      // 参照画像は、作業ディレクトリのファイルとして書く。参照画像がなければ undefined。
      const writeReference = Effect.fnUntraced(function* (
        workDirectory: string,
        referenceImage: GenerateRequest["referenceImage"],
      ) {
        if (referenceImage === undefined) {
          return undefined;
        }
        const referencePath = path.join(
          workDirectory,
          `reference.${referenceImage.mimeType.replace("image/", "")}`,
        );
        yield* fileSystem.writeFile(referencePath, referenceImage.bytes).pipe(Effect.orDie);
        return referencePath;
      });

      const readOutput = Effect.fnUntraced(function* (workDirectory: string) {
        // 出力は codex が書くもの。ない・ディレクトリ・読めないはいずれも「画像がない」失敗として型付けする。
        const bytes = yield* fileSystem
          .readFile(path.join(workDirectory, outputFileName))
          .pipe(Effect.mapError(() => new CodexImageMissing()));
        return { bytes, mimeType: "image/png" };
      });

      const generate = Effect.fn("CodexImageGenerator.generate")(function* (
        request: GenerateRequest,
      ) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const workDirectory = yield* fileSystem
              .makeTempDirectoryScoped({ prefix: "nyaucast-codex-" })
              .pipe(Effect.orDie);
            const referencePath = yield* writeReference(workDirectory, request.referenceImage);
            const referenceName =
              referencePath === undefined ? undefined : path.basename(referencePath);
            const exitCode = yield* run([
              "exec",
              "--skip-git-repo-check",
              "--ephemeral",
              "--sandbox",
              "workspace-write",
              "--cd",
              workDirectory,
              // `--image` は複数の値を取るので、`--` で止めないと直後のプロンプトも画像のパスとして読まれる。
              ...(referencePath === undefined ? [] : ["--image", referencePath, "--"]),
              `${instructionPreamble(referenceName)}\n${request.prompt}`,
            ]);
            if (exitCode !== 0) {
              return yield* new CodexExecFailed({ exitCode });
            }
            return yield* readOutput(workDirectory);
          }),
        );
      });

      return CodexImageGenerator.of({ generate, requireLogin });
    }),
  );
}
