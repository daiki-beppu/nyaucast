import { Context } from "effect";

/**
 * stdin が TTY かどうか。`Terminal` には判定が無いので、entry point が 1 回だけ解決して渡す。
 * 公開ゲートの対話が、TTY のときだけ動くために使う。
 */
export class StdinTerminal extends Context.Service<
  StdinTerminal,
  { readonly isTerminal: boolean }
>()("nyaucast/StdinTerminal") {}
