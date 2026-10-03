import { join } from "node:path";

import {
  Browser,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
} from "@puppeteer/browsers";
import { Context, Deferred, Effect, FileSystem, Layer, type Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { connectCdp, ChromeUnavailable, type CdpConnection } from "./cdp.ts";
import { chromeHeadlessShellBuildId } from "./chrome-pin.ts";

export { ChromeUnavailable };

/** chrome-headless-shell のダウンロード先。CI の cache の path と同じ形（`<home>/.cache/nyaucast/chrome`）。 */
export const chromeCacheDirectory = (home: string) => join(home, ".cache", "nyaucast", "chrome");

const listeningPattern = /DevTools listening on (ws:\/\/\S+)/u;

/** Chrome の 1 ページ。スコープが終わると、Chrome のプロセスと一時ディレクトリごと片付く。 */
export interface ChromePage {
  readonly connection: CdpConnection;
  readonly sessionId: string;
}

const executableOf = (cacheDirectory: string) =>
  computeExecutablePath({
    browser: Browser.CHROMEHEADLESSSHELL,
    buildId: chromeHeadlessShellBuildId,
    cacheDir: cacheDirectory,
  });

// 空のキャッシュへ複数のプロセスが同時にダウンロードしても壊れないよう、一時ディレクトリへ install してから版のディレクトリを rename で置く。
// 先に誰かが置いていれば rename は失敗するので、その場合は置かれたものを使い、こちらの一時ディレクトリを捨てる。
const installInto = (fileSystem: FileSystem.FileSystem, cacheDirectory: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const platform = detectBrowserPlatform();
      if (platform === undefined) return yield* Effect.fail(undefined);
      yield* fileSystem.makeDirectory(cacheDirectory, { recursive: true });
      const staging = yield* fileSystem.makeTempDirectoryScoped({
        directory: cacheDirectory,
        prefix: ".install-",
      });
      const installed = yield* Effect.tryPromise(() =>
        install({
          browser: Browser.CHROMEHEADLESSSHELL,
          buildId: chromeHeadlessShellBuildId,
          cacheDir: staging,
          platform,
        }),
      );
      const versionPath = join(
        Browser.CHROMEHEADLESSSHELL,
        `${installed.platform}-${installed.buildId}`,
      );
      yield* fileSystem.makeDirectory(join(cacheDirectory, Browser.CHROMEHEADLESSSHELL), {
        recursive: true,
      });
      yield* fileSystem
        .rename(join(staging, versionPath), join(cacheDirectory, versionPath))
        .pipe(Effect.ignore);
    }),
  );

const supply = (cacheDirectory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const executable = executableOf(cacheDirectory);
    if (!(yield* fileSystem.exists(executable))) {
      yield* installInto(fileSystem, cacheDirectory);
    }
    return (yield* fileSystem.exists(executable)) ? executable : yield* Effect.fail(undefined);
  }).pipe(Effect.mapError(() => new ChromeUnavailable({ stage: "download" })));

// Linux の ubuntu-24.04 は、AppArmor が非特権の user namespace を制限するため、Chrome の sandbox が起動できない。
// この Chrome が開くのは tool 自身が組み立てた composition のファイルだけなので、Linux では sandbox を切る。
const launchFlags = (userDataDirectory: string) => [
  "--remote-debugging-port=0",
  `--user-data-dir=${userDataDirectory}`,
  "--hide-scrollbars",
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
  "--disable-gpu",
  ...(process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
];

// stderr は最後まで読み続ける（パイプを詰まらせない）。最初の接続先の行を見つけたら deferred に渡す。
const watchListening = (
  stderr: Stream.Stream<Uint8Array, unknown>,
  listening: Deferred.Deferred<string, ChromeUnavailable>,
) =>
  stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => {
      const url = listeningPattern.exec(line)?.[1];
      return url === undefined ? Effect.void : Deferred.succeed(listening, url);
    }),
    Effect.ignore,
    Effect.andThen(Deferred.fail(listening, new ChromeUnavailable({ stage: "launch" }))),
  );

const launch = (executable: string, userDataDirectory: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(executable, launchFlags(userDataDirectory), { stdin: "ignore" }),
    );
    const listening = yield* Deferred.make<string, ChromeUnavailable>();
    yield* Effect.forkScoped(Stream.runDrain(handle.stdout).pipe(Effect.ignore));
    yield* Effect.forkScoped(watchListening(handle.stderr, listening));
    return yield* Deferred.await(listening);
  }).pipe(Effect.mapError(() => new ChromeUnavailable({ stage: "launch" })));

const openTarget = (connection: CdpConnection) =>
  Effect.gen(function* () {
    const created = (yield* connection.send("Target.createTarget", { url: "about:blank" })) as {
      readonly targetId: string;
    };
    const attached = (yield* connection.send("Target.attachToTarget", {
      flatten: true,
      targetId: created.targetId,
    })) as { readonly sessionId: string };
    yield* connection.send("Page.enable", {}, attached.sessionId);
    return { connection, sessionId: attached.sessionId } satisfies ChromePage;
  });

/** chrome-headless-shell を供給し（初回はダウンロード）、起動して CDP で 1 ページ開く。使えるのは render と preview の tool だけ（viewport は composition が申告する寸法で、呼び出し側が設定する）。 */
export class Chrome extends Context.Service<
  Chrome,
  {
    openPage: Effect.Effect<ChromePage, ChromeUnavailable, Scope.Scope>;
  }
>()("nyaucast/lib/Chrome") {
  static layer(options: { readonly cacheDirectory: string }) {
    return Layer.effect(
      Chrome,
      Effect.gen(function* () {
        const context = yield* Effect.context<
          ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
        >();
        const openPage = Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const executable = yield* supply(options.cacheDirectory);
          const userDataDirectory = yield* fileSystem
            .makeTempDirectoryScoped({ prefix: "nyaucast-chrome-" })
            .pipe(Effect.mapError(() => new ChromeUnavailable({ stage: "launch" })));
          const url = yield* launch(executable, userDataDirectory);
          const connection = yield* connectCdp(url);
          return yield* openTarget(connection);
        }).pipe(Effect.provideContext(context));
        return Chrome.of({ openPage });
      }),
    );
  }
}
