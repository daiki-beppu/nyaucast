import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { cfExecutablePath } from "../lib/cf-bin.ts";
import { runCommand } from "../lib/command-output.ts";

// nyaucast 専用の cf プロファイル名。利用者の既定プロファイルは使わない（order.md 決定 1 行目）。
export const cfProfileName = "nyaucast";

// 失敗は、どの操作で起きたかだけを事実に持つ。cf 自身の標準出力・標準エラーは、認証の案内や
// アカウント名を含みうるため事実にしない（issue #696 AC 3 行目: 秘密の値は標準出力に出さない）。
export class CfCommandFailed extends Schema.TaggedError<CfCommandFailed>()("CfCommandFailed", {
  operation: Schema.Literals(["accounts", "token", "whoami"]),
}) {}

// このモジュールの外は `Cf` の呼び出し元として構造的に合わせるだけで、型名を import しない。
type CfAccount = { readonly id: string; readonly name: string };

/** デプロイ用トークンに与える 1 つの policy。`--policies` の JSON へはこのモジュールが変換する。 */
type CfTokenPolicy = {
  readonly effect: "allow";
  readonly permissionGroupIds: ReadonlyArray<string>;
  readonly resources: Record<string, string>;
};

type CfCreateTokenInput = {
  readonly accountId: string;
  readonly expiresOn: string;
  readonly name: string;
  readonly policies: ReadonlyArray<CfTokenPolicy>;
};

type CfOperation = "accounts" | "token" | "whoami";

const WhoamiResponseSchema = Schema.Struct({ authenticated: Schema.Boolean });
const decodeWhoami = Schema.decodeUnknownEffect(Schema.fromJsonString(WhoamiResponseSchema));

const CfAccountSchema = Schema.Struct({ id: Schema.String, name: Schema.String });
const decodeAccounts = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(CfAccountSchema)),
);

const TokenCreateResponseSchema = Schema.Struct({ value: Schema.String });
const decodeTokenCreate = Schema.decodeUnknownEffect(
  Schema.fromJsonString(TokenCreateResponseSchema),
);

// cf の `--policies` が期待する、Cloudflare API そのままの wire 形（snake_case）へ変換する。
const toWirePolicy = (policy: CfTokenPolicy) => ({
  effect: policy.effect,
  permission_groups: policy.permissionGroupIds.map((id) => ({ id })),
  resources: policy.resources,
});

// cf 自身が env に残すと local-install 委譲（node_modules/cf/bin/cf）で使う変数名（exact match）。
// 親プロセスのこの 2 つは、専用プロファイルの認証判定を乗っ取れるため、子プロセス環境から落とす
// （issue #696 ARCH-001・AI-001。cf の解決順は 1. CLOUDFLARE_API_TOKEN 2. --profile の OAuth）。
const authTokenEnvKeys = new Set(["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"]);

// 親プロセスの環境から、認証トークンの変数だけを落とした子プロセス環境のベースを組む（境界で1回だけ）。
// `--profile` 経由の OAuth 以外の認証元を子プロセスへ渡さない一方、PATH・HOME・XDG_CONFIG_HOME などは
// そのまま継承する（`cf` が profile の保存場所を見失わないため）。
const sanitizedParentEnv = (
  parentEnv: Record<string, string | undefined>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(parentEnv).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !authTokenEnvKeys.has(entry[0]),
    ),
  );

const makeCf = (parentEnv: Record<string, string | undefined>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // cf 自身の local-install 委譲（node_modules/cf/bin/cf の maybeDelegateFromProcess）を抑止する。
    // 抑止しないと、cwd 側に realpath の異なる別の cf があれば処理がそちらへ渡ってしまう
    // （issue #696 SEC-001。cf 自身も委譲時に子へこの変数を渡す）。
    const baseChildEnv: Record<string, string> = {
      ...sanitizedParentEnv(parentEnv),
      CF_DELEGATION: "1",
    };

    // cf の実行ファイルは nyaucast 自身の依存解決から得て、node の引数として起こす（ADR-0012 決定 7。
    // shebang に頼ると PATH の env node が要る）。全呼び出しに専用プロファイルの指定を添える（要件 13）。
    // 子プロセス環境は `Cf` 境界が唯一組む: 親環境の継承分 → 委譲抑止 → 呼び出しごとの追加値の順で重ねる
    // （呼び出しごとの追加値が最後に重なるので、同名キーがあってもそれが勝つ）。
    const invoke = (
      operation: CfOperation,
      args: ReadonlyArray<string>,
      extraEnv: Record<string, string> = {},
    ) =>
      runCommand(
        spawner,
        process.execPath,
        [cfExecutablePath(), ...args, "--profile", cfProfileName],
        { env: { ...baseChildEnv, ...extraEnv } },
      ).pipe(
        Effect.mapError(() => new CfCommandFailed({ operation })),
        Effect.flatMap(({ exitCode, stdout }) =>
          exitCode === 0 ? Effect.succeed(stdout) : Effect.fail(new CfCommandFailed({ operation })),
        ),
      );

    const whoami = invoke("whoami", ["auth", "whoami"]).pipe(
      Effect.flatMap((stdout) =>
        decodeWhoami(stdout).pipe(
          Effect.map((response) => response.authenticated),
          Effect.mapError(() => new CfCommandFailed({ operation: "whoami" })),
        ),
      ),
    );

    const listAccounts = invoke("accounts", ["accounts", "list"]).pipe(
      Effect.flatMap((stdout) =>
        decodeAccounts(stdout).pipe(
          Effect.mapError(() => new CfCommandFailed({ operation: "accounts" })),
        ),
      ),
    );

    const createToken = (input: CfCreateTokenInput) =>
      invoke(
        "token",
        [
          "accounts",
          "tokens",
          "create",
          "--name",
          input.name,
          "--expires-on",
          input.expiresOn,
          "--policies",
          JSON.stringify(input.policies.map(toWirePolicy)),
        ],
        { CLOUDFLARE_ACCOUNT_ID: input.accountId },
      ).pipe(
        Effect.flatMap((stdout) =>
          decodeTokenCreate(stdout).pipe(
            Effect.map((response) => Redacted.make(response.value)),
            Effect.mapError(() => new CfCommandFailed({ operation: "token" })),
          ),
        ),
      );

    return Cf.of({ createToken, listAccounts, whoami });
  });

/**
 * `cf` の argv・専用プロファイル・出力の解釈の唯一の所有者。実行ファイルは nyaucast 自身の依存解決
 * から得る（`cf-bin.ts`）。失敗は操作の種類だけを事実に持ち、cf 自身の出力は漏らさない。
 */
export class Cf extends Context.Service<
  Cf,
  {
    readonly whoami: Effect.Effect<boolean, CfCommandFailed>;
    readonly listAccounts: Effect.Effect<ReadonlyArray<CfAccount>, CfCommandFailed>;
    readonly createToken: (
      input: CfCreateTokenInput,
    ) => Effect.Effect<Redacted.Redacted<string>, CfCommandFailed>;
  }
>()("nyaucast/Cf") {
  // `parentEnv` は呼び出し元が境界で1回だけ解決したプロセスの環境（`src/index.ts` では
  // `process.env`）。`Cf` はここから子プロセス環境を1つ組み、以降は内部で再解決しない。
  static layer(
    parentEnv: Record<string, string | undefined>,
  ): Layer.Layer<Cf, never, ChildProcessSpawner.ChildProcessSpawner> {
    return Layer.effect(Cf, makeCf(parentEnv));
  }
}
