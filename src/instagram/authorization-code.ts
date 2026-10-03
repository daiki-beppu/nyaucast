import { Effect, Redacted } from "effect";
import { Prompt } from "effect/cli";
import open from "open";

/**
 * Meta は redirect_uri に HTTPS を要求するので、この localhost の URL は loopback の受け取り口ではない。
 * ブラウザで承認した後に遷移した先の URL（`?code=…&state=…`）を、運営者が貼り付ける。
 */
export const redirectUri = "https://localhost:53682/oauth2callback";

/** 認可 URL をブラウザで開き、貼り付けられた遷移先の URL から code と state を取り出す。 */
export const receiveCodeByPaste = (authorizationUrl: string) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => open(authorizationUrl));
    const pasted = yield* Prompt.Hidden({
      message: "承認後に遷移した先の URL（?code=…&state=… を含む）を貼り付けてください",
    });
    // URL として読めない入力は例外にせず、型付きの失敗にする（呼び出し側が認可の失敗に変換する）。
    const query = (yield* Effect.try(() => new URL(Redacted.value(pasted)))).searchParams;
    return {
      ...(query.has("code") ? { code: query.get("code") as string } : {}),
      ...(query.has("state") ? { state: query.get("state") as string } : {}),
    };
  });
