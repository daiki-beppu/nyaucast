import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Deferred, Effect, Layer, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

/** 偽の codex が `exec` で返す結果。image があれば作業ディレクトリの thumbnail.png に書く。 */
export interface CodexExecReply {
  /** 終了コード。省略は 0。 */
  readonly exitCode?: number;
  /** 作業ディレクトリ（`--cd`）の thumbnail.png に書く画像。省略は何も書かない。 */
  readonly image?: Uint8Array;
  /** 標準出力に流す文字列。成否の判断に使われないことを確かめるため、成功らしい文言も流せる。 */
  readonly stdout?: string;
  /** thumbnail.png をファイルではなくディレクトリにする（読めない出力の代表例）。image より優先する。 */
  readonly outputAsDirectory?: true;
  /** 終了コードを返す前に、この Deferred が完了するまで待つ。実行が重なるかを観測するために使う。 */
  readonly hold?: Deferred.Deferred<void>;
  /** プロセスを起動できない（codex が入っていないなど）。 */
  readonly spawnFailure?: true;
}

export interface CodexCall {
  readonly args: readonly string[];
  readonly command: string;
  /** `exec` のときの `--cd` の値。 */
  readonly workDir?: string;
  /** `exec` のとき、`--image` が取った値のパス（複数の値を取り、次の `-` で始まる要素で止まる）。 */
  readonly imagePaths?: readonly string[];
  /** `exec` のとき、`imagePaths` の各ファイルの、起動した時点のバイト列。 */
  readonly imageBytes?: readonly Uint8Array[];
  /** `exec` のとき、位置引数のプロンプト。`--` の後ろか、オプションの値にならなかった要素。なければ undefined。 */
  readonly prompt?: string;
}

export interface FakeCodexOptions {
  /** `codex login status` の結果。省略は "logged-in"。 */
  readonly login?: "logged-in" | "logged-out" | "unavailable";
  /** `codex exec` の応答を、呼ばれた順に。尽きた後の呼び出しは defect。 */
  readonly replies?: readonly CodexExecReply[];
}

// 実 CLI の解析の契約: `--image` は複数の値を取り、`-` で始まる要素（`--` を含む）で止まる。
// `--` の後ろは位置引数。`--cd` と `--sandbox` は値を 1 つ取る。それ以外のフラグは値を取らない。
const isOption = (arg: string | undefined) => arg?.startsWith("-") === true;

// `flag` の直後から、次の `-` で始まる要素までの添字。`--image` は複数、`--cd` と `--sandbox` は 1 つの値を取る。
const valueIndexes = (options: readonly string[], flag: string, many: boolean) => {
  const start = options.indexOf(flag) + 1;
  if (start === 0) {
    return [];
  }
  const end = options.findIndex((arg, index) => index >= start && isOption(arg));
  const stop = end < 0 ? options.length : end;
  return Array.from(
    { length: (many ? stop : Math.min(stop, start + 1)) - start },
    (_, i) => start + i,
  );
};

const parseExec = (args: readonly string[]) => {
  const rest = args.slice(1);
  const separator = rest.indexOf("--");
  const options = separator < 0 ? rest : rest.slice(0, separator);
  const imageIndexes = valueIndexes(options, "--image", true);
  const cdIndexes = valueIndexes(options, "--cd", false);
  const sandboxIndexes = valueIndexes(options, "--sandbox", false);
  const consumed = new Set([...imageIndexes, ...cdIndexes, ...sandboxIndexes]);
  const bare = options.filter((arg, index) => !isOption(arg) && !consumed.has(index));
  const positional = [...bare, ...(separator < 0 ? [] : rest.slice(separator + 1))];
  return {
    imagePaths: imageIndexes.map((index) => options[index] ?? ""),
    prompt: positional[0],
    workDir: cdIndexes.length === 0 ? undefined : options[cdIndexes[0] ?? 0],
  };
};

const spawnError = () =>
  PlatformError.systemError({
    _tag: "NotFound",
    method: "spawn",
    module: "ChildProcess",
    pathOrDescriptor: "codex",
  });

const handleOf = (exitCode: number, stdoutText: string, hold?: Deferred.Deferred<void>) => {
  const stdout = Stream.make(new TextEncoder().encode(stdoutText));
  return ChildProcessSpawner.makeHandle({
    all: stdout,
    exitCode: (hold === undefined ? Effect.void : Deferred.await(hold)).pipe(
      Effect.as(ChildProcessSpawner.ExitCode(exitCode)),
    ),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    pid: ChildProcessSpawner.ProcessId(1),
    stderr: Stream.empty,
    stdin: Sink.drain,
    stdout,
    unref: Effect.succeed(Effect.void),
  });
};

/**
 * 偽の codex CLI（子プロセスの起動の偽装）。本物は起動しない。呼ばれた順にすべて記録する。
 * - `codex login status`: login の指定どおりに終わる
 * - `codex exec ...`: 用意した応答を順に返す。image があれば `--cd` の値のディレクトリの thumbnail.png に書く
 * - それ以外の呼び出しと、応答が尽きた後の `exec` は、想定外の呼び出しとして defect にする
 */
export function fakeCodex(options: FakeCodexOptions = {}) {
  const pending = [...(options.replies ?? [])];
  const calls: CodexCall[] = [];
  const login = options.login ?? "logged-in";
  const runLoginStatus = () =>
    login === "unavailable"
      ? spawnError()
      : Effect.succeed(handleOf(login === "logged-in" ? 0 : 1, ""));
  const recordExec = (args: readonly string[]) => {
    const { imagePaths, prompt, workDir } = parseExec(args);
    calls.push({
      args,
      command: "codex",
      ...(workDir === undefined ? {} : { workDir }),
      ...(imagePaths.length === 0
        ? {}
        : {
            // プロンプトが画像のパスとして読まれた（区切りがない）ときは、存在しないパスを読まない。
            ...(prompt === undefined
              ? {}
              : { imageBytes: imagePaths.map((file) => new Uint8Array(readFileSync(file))) }),
            imagePaths,
          }),
      ...(prompt === undefined ? {} : { prompt }),
    });
    return { prompt, workDir };
  };
  const writeOutput = (reply: CodexExecReply, workDir: string | undefined) => {
    if (workDir === undefined) {
      return;
    }
    if (reply.outputAsDirectory === true) {
      mkdirSync(join(workDir, "thumbnail.png"));
    } else if (reply.image !== undefined) {
      writeFileSync(join(workDir, "thumbnail.png"), reply.image);
    }
  };
  const answerExec = (reply: CodexExecReply, parsed: ReturnType<typeof recordExec>) => {
    writeOutput(reply, parsed.workDir);
    return handleOf(reply.exitCode ?? 0, reply.stdout ?? "", reply.hold);
  };
  const runExec = (args: readonly string[]) => {
    const parsed = recordExec(args);
    // 実 CLI はプロンプトがないと何も生成せず、終了コード 1 で終わる。用意した応答は消費せず、出力も書かない。
    if (parsed.prompt === undefined) {
      return Effect.succeed(handleOf(1, ""));
    }
    const reply = pending.shift();
    if (reply === undefined) {
      return Effect.die("test response queue is empty");
    }
    return reply.spawnFailure === true ? spawnError() : Effect.succeed(answerExec(reply, parsed));
  };
  const isCodex = (command: string, args: readonly string[], ...subcommand: readonly string[]) =>
    command === "codex" && subcommand.every((word, index) => args[index] === word);
  const spawner = ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("unexpected pipeline command");
    }
    const { args } = command;
    if (isCodex(command.command, args, "exec")) {
      return runExec(args);
    }
    calls.push({ args, command: command.command });
    return isCodex(command.command, args, "login", "status")
      ? runLoginStatus()
      : Effect.die(`unexpected command: ${[command.command, ...args].join(" ")}`);
  });
  return {
    calls,
    /** `codex exec` の呼び出しだけ。 */
    get execCalls() {
      return calls.filter((call) => call.args[0] === "exec");
    },
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  };
}

export type FakeCodex = ReturnType<typeof fakeCodex>;
