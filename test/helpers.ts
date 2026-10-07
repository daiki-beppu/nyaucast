import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { ConfigProvider, Context, Effect, Layer, Result, Schema, Sink, Stream } from "effect";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { SqlClient } from "effect/sql";
import { TestClock, TestConsole } from "effect/testing";

import { ChannelAccounts } from "../src/auth/accounts.ts";
import { CredentialStore } from "../src/auth/credential-store.ts";
import { DeclaredAccounts } from "../src/auth/declared-accounts.ts";
import { StaticSecrets } from "../src/auth/secrets.ts";
import { ChannelSettings } from "../src/channel/channel-settings.ts";
import { CloudflareEnvironment } from "../src/cloudflare/environment.ts";
import { LocalStore } from "../src/db/local-store.ts";
import { InstagramAuth } from "../src/instagram/auth.ts";
import { ThumbnailFiles } from "../src/thumbnails/thumbnail-files.ts";
import { VideoFiles } from "../src/videos/video-files.ts";
import { StdinTerminal } from "../src/videos/stdin-terminal.ts";
import { XAuth } from "../src/x/auth.ts";
import { XClient } from "../src/x/client.ts";
import { YouTubeClient } from "../src/youtube/client.ts";
import { YouTubeAuth } from "../src/youtube/auth.ts";

export function withTemporaryDirectory<T>(prefix: string, execute: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return execute(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export async function withTemporaryDirectoryAsync<Value>(
  prefix: string,
  execute: (directory: string) => Promise<Value>,
): Promise<Value> {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await execute(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

/** Effect 版: スコープが閉じたときに一時ディレクトリを消す。 */
export const temporaryDirectory = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), prefix))),
    (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
  );

export function localDatabasePath(channelRoot: string): string {
  return join(channelRoot, "data", "local.db");
}

/** local store を開く唯一の口 `LocalStore.layer(url)` へ渡す接続先。チャンネルルートの data/local.db。 */
export function localDatabaseUrl(channelRoot: string): string {
  return pathToFileURL(localDatabasePath(channelRoot)).href;
}

/** 一時ディレクトリの実ファイル libSQL（マイグレーション適用済み）と、FileSystem / Path を提供する。 */
export const channelLayer = (channelRoot: string) =>
  Layer.mergeAll(
    LocalStore.layer(localDatabaseUrl(channelRoot)).pipe(Layer.provide(NodeServices.layer)),
    NodeServices.layer,
  );

const notUsed = Effect.die("このテストでは使わないサブコマンドの Layer が組まれた");

/** auth を使わないテストが CLI のプログラムへ渡す Layer。組まれたら失敗する。 */
export const unusedAuthLayer = Layer.mergeAll(
  Layer.effect(ChannelAccounts, notUsed),
  Layer.effect(CredentialStore, notUsed),
  Layer.effect(InstagramAuth, notUsed),
  Layer.effect(XAuth, notUsed),
  Layer.effect(YouTubeAuth, notUsed),
);

/** cloudflare（`nyaucast cloudflare status`）を使わないテストが CLI のプログラムへ渡す Layer。組まれたら失敗する。 */
export const unusedCloudflareLayer = Layer.effect(CloudflareEnvironment, notUsed);

/** video を使わないテストが CLI のプログラムへ渡す Layer。組まれたら失敗する。 */
export const unusedVideoLayer = Layer.mergeAll(
  Layer.effect(SqlClient.SqlClient, notUsed),
  Layer.effect(ChannelSettings, notUsed),
  Layer.effect(CredentialStore, notUsed),
  Layer.effect(DeclaredAccounts, notUsed),
  Layer.effect(StdinTerminal, notUsed),
  Layer.effect(ThumbnailFiles, notUsed),
);

/** post（`nyaucast post run`）を使わないテストが CLI のプログラムへ渡す Layer。組まれたら失敗する（C20）。 */
export const unusedPostLayer = Layer.mergeAll(
  Layer.effect(SqlClient.SqlClient, notUsed),
  Layer.effect(ChannelSettings, notUsed),
  Layer.effect(CredentialStore, notUsed),
  Layer.effect(DeclaredAccounts, notUsed),
  Layer.effect(HttpClient.HttpClient, notUsed),
  Layer.effect(InstagramAuth, notUsed),
  Layer.effect(StaticSecrets, notUsed),
  Layer.effect(VideoFiles, notUsed),
  Layer.effect(XClient, notUsed),
  Layer.effect(YouTubeClient, notUsed),
);

/**
 * 偽の認証と偽の `HttpClient` の上に、本物の client の Layer を組む関数を作る。SNS ごとの fixture
 * （`test/x-fake-client.ts` / `test/youtube-fake-client.ts`）は、client・認証の tag・既定の偽の認証
 * だけを渡す。組み立て自体はどの SNS でも同じで、`Client.layer` の依存が変われば一緒に変わる。
 */
export const clientLayerOnFakes =
  <Client, Auth, AuthService>(
    client: Layer.Layer<Client, never, Auth | HttpClient.HttpClient>,
    authTag: Context.Key<Auth, AuthService>,
    defaultAuth: () => AuthService,
  ) =>
  (
    http: Layer.Layer<HttpClient.HttpClient>,
    auth: AuthService = defaultAuth(),
  ): Layer.Layer<Client> =>
    client.pipe(Layer.provide(Layer.succeed(authTag, auth)), Layer.provide(http));

/**
 * CLI のプログラムを in-process で実行する。観測点は 3 つ: 成功・失敗（outcome）、stdout の行（logs）、stderr の行（errors）。
 * TestConsole は同じテストの中の実行をまたいで行を溜める（Layer は同じ参照なら同じ instance になる）ので、
 * この実行が出した行だけを返す。
 */
export const runProgram = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const logsBefore = (yield* TestConsole.logLines).length;
    const errorsBefore = (yield* TestConsole.errorLines).length;
    const outcome = yield* Effect.result(program);
    const logs = (yield* TestConsole.logLines).slice(logsBefore).map(String);
    const errors = (yield* TestConsole.errorLines).slice(errorsBefore).map(String);
    return { errors, logs, outcome, stdout: logs.map((line) => `${line}\n`).join("") };
  }).pipe(Effect.provide(TestConsole.layer));

/** 一時ディレクトリを 1 つ作り、その中のチャンネルとして use を実行する（スコープ終了で後始末）。 */
export const withChannel = <A, E, R>(
  prefix: string,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const channelRoot = yield* temporaryDirectory(prefix);
    return yield* use(channelRoot).pipe(Effect.provide(channelLayer(channelRoot)));
  });

/** TestClock を絶対時刻に合わせる。ゲート事実の時刻は Clock から取られるため、テストはここで時刻を決める。 */
export const setClock = (iso: string) => TestClock.setTime(Date.parse(iso));

export const insertCollection = (collection: { id: string; title: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO collections (id, title) VALUES (${collection.id}, ${collection.title})`;
  });

export const selectAll = (
  table:
    | "approvals"
    | "collections"
    | "explainer_approvals"
    | "explainer_cut_exports"
    | "explainer_cut_previews"
    | "explainer_plans"
    | "explainer_post_attempt_results"
    | "explainer_post_attempts"
    | "explainer_post_cancellations"
    | "explainer_post_drafts"
    | "explainer_post_publications"
    | "explainer_post_upload_failures"
    | "explainer_posts"
    | "explainer_rejections"
    | "explainer_short_recommendations"
    | "explainer_short_versions"
    | "explainer_short_withdrawals"
    | "explainer_thumbnail_candidates"
    | "explainer_thumbnail_exclusions"
    | "explainer_thumbnail_rejections"
    | "explainer_thumbnail_selections"
    | "explainer_videos"
    | "rejections"
    | "thumbnails",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM ${table}`);
  });

/** チャンネルルートの config/channel/video.json（動画の種類・ジャンル・当たる型の宣言）を書く。 */
export function writeVideoConfig(channelRoot: string, content: string): void {
  mkdirSync(join(channelRoot, "config", "channel"), { recursive: true });
  writeFileSync(join(channelRoot, "config", "channel", "video.json"), content);
}

type Decoder = Parameters<typeof Schema.decodeUnknownResult>[0];

/**
 * Schema が入力を受け入れるか。未知のキーは拒否する（`Tool.Strict` の tool を McpServer が検証するときと同じ
 * `onExcessProperty: "error"`）。strict の検証に使う。
 */
export function accepts(schema: Decoder, input: unknown): boolean {
  return Result.isSuccess(Schema.decodeUnknownResult(schema)(input, { onExcessProperty: "error" }));
}

/** McpServer が strict な tool の inputSchema として公開する JSON Schema の `additionalProperties`。 */
export function publishedAdditionalProperties(tool: { parametersSchema: Decoder }): unknown {
  return Schema.toJsonSchemaDocument(tool.parametersSchema, {
    onExcessProperty: "error",
  }).schema["additionalProperties"];
}

/** 環境変数（Config の既定の読み取り元）を、テストが決めた値だけに差し替える。ホストの環境変数は見えない。 */
export const environment = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env }));

/** 外部コマンド（`op` など）の偽物。呼ばれたコマンドを記録し、決めた終了コードと標準出力で終わる。 */
export function fakeSpawner(outcome: { exitCode: number; stdout: string }) {
  const calls: Array<{ args: ReadonlyArray<string>; command: string }> = [];
  const stdout = Stream.make(new TextEncoder().encode(outcome.stdout));
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag === "StandardCommand") {
        calls.push({ args: command.args, command: command.command });
      }
      return ChildProcessSpawner.makeHandle({
        all: stdout,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(outcome.exitCode)),
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
    }),
  );
  return { calls, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner) };
}

/** 親ディレクトリごと JSON ファイルを書く（テストの前提データ用）。 */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

/** 失敗が持つ値（タグと事実の field）。CLI が stderr に出す内容と同じ観測単位で、field の並びには依存しない。 */
export function failureFacts(failure: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(failure as object));
}
