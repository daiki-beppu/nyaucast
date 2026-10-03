import { Effect } from "effect";
import { getAuthCode } from "oauth-callback";
import open from "open";

const callbackHostname = "127.0.0.1";
const callbackPath = "/oauth2callback";
const callbackPort = 53_682;

export const redirectUri = `http://${callbackHostname}:${callbackPort}${callbackPath}`;

/** 認可 URL をブラウザで開き、loopback の redirect で渡る code と state を受け取る。 */
export const receiveCodeByLoopback = (authorizationUrl: string) =>
  Effect.tryPromise(() =>
    getAuthCode({
      authorizationUrl,
      callbackPath,
      hostname: callbackHostname,
      launch: (url) => open(url),
      port: callbackPort,
    }),
  );
