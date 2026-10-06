import { Context, Semaphore } from "effect";

// video.renderCut の呼び出しを直列にするロック（previewCut は自分のロックを持つ）。
// 目的は、同じ動画への並行する描画が、同じ一時ファイルへ書いてぶつからず、同じ行を二重に積まないこと。
// entry point は提供しないので、既定値（プロセスに 1 つ）が使われ、本番ではプロセスの中のすべての描画が直列になる。
// テストはチャンネルごとに新しいロックを提供し、別のチャンネルの描画を並走させる（#708）。
export const RenderLock = Context.Reference<Semaphore.Semaphore>("nyaucast/RenderLock", {
  defaultValue: () => Semaphore.makeUnsafe(1),
});
