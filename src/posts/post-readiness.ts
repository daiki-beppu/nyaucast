import { Effect, Option, Result } from "effect";
import type { SqlClient } from "effect/sql";

import type { Platform } from "../auth/account-key.ts";
import type { AccountsDeclarationInvalid } from "../auth/accounts.ts";
import { CredentialStore, type CredentialStoreFailure } from "../auth/credential-store.ts";
import { DeclaredAccounts } from "../auth/declared-accounts.ts";
import { lastCutExport, type CutExport } from "../db/explainer-cuts.ts";
import { readThumbnailFacts, type ThumbnailSelection } from "../db/explainer-thumbnails.ts";
import { VideoFiles } from "../videos/video-files.ts";
import type { PostReadiness } from "./post-state.ts";

export interface ReadinessInput {
  /** 公開ゲートで承認したときに確定した投稿先（#656。書いたら変えない。ADR-0009 決定 9）。 */
  readonly accountId: string;
  readonly cut: string;
  /** その投稿を承認した時刻（R9: 動画全体の最新の承認時刻ではなく、この投稿自身の時刻で測る）。 */
  readonly createdAt: string;
  readonly platform: Platform;
  readonly videoId: string;
}

/**
 * 投稿に保存した ID・宣言・トークンに記録した ID の照合（ADR-0009 決定 6）。宣言が無い・トークンが
 * 無い・宣言と投稿の ID が違う（承認の後に宣言を替えた。#656）・トークンと宣言の ID が違う、いずれも
 * 照合落ち（true）。宣言の読み込み自体が壊れている（AccountsDeclarationInvalid）場合は、
 * 確認待ちにせず、そのまま上位へ伝える。チャンネル名は宣言から得る（宣言が無ければ比較の前に落ちる）。
 */
const checkAccountMismatch = (
  input: ReadinessInput,
): Effect.Effect<
  boolean,
  AccountsDeclarationInvalid | CredentialStoreFailure,
  CredentialStore | DeclaredAccounts
> =>
  Effect.gen(function* () {
    const declared = yield* (yield* DeclaredAccounts).require(input.platform).pipe(Effect.result);
    if (Result.isFailure(declared)) {
      if (declared.failure._tag === "AccountNotDeclared") return true;
      return yield* declared.failure;
    }
    if (declared.success.id !== input.accountId) return true;
    const credential = yield* (yield* CredentialStore).read(
      declared.success.channel,
      input.platform,
    );
    return Option.isNone(credential) || credential.value.accountId !== declared.success.id;
  });

interface StaleFactsCheck {
  readonly lastExport: Option.Option<CutExport>;
  readonly stale: boolean;
  readonly thumbnailSelection: ThumbnailSelection | undefined;
}

/**
 * 公開ゲートの承認（この投稿自身の created_at）が、そのカットの最後の書き出しと最後のサムネイルの
 * 選択より新しいこと、かつ最後の書き出しの相対キーにファイルがあること（ADR-0009 決定 9・11）。
 * ファイルの存在は実行の直前の検査の最後の読み取り（P3: この位置・この呼び出しは変えない。
 * C6/SCN-C-CONCURRENT-ACQUIRE-N1 のランデブーはこの呼び出しを基準にしている）。
 *
 * P3: ここで読んだ事実（最後の書き出し・サムネイルの選択）をそのまま呼び出し側へ返す。呼び出し側
 * （due-posts.ts）が、この後の送信前処理で同じ事実を再び読み直すと、検査した事実と送信前処理が
 * 読む事実の間に別の fiber の書き込みが挟まり、検査した事実と実際に送信する事実が食い違う
 * （チェック対象と使用対象の不一致）おそれがある。検査した事実を再利用することで、この不一致を防ぐ。
 */
const checkStaleFacts = (
  input: ReadinessInput,
): Effect.Effect<StaleFactsCheck, never, SqlClient.SqlClient | VideoFiles> =>
  Effect.gen(function* () {
    const lastExport = yield* lastCutExport(input.videoId, input.cut);
    if (Option.isNone(lastExport)) {
      return { lastExport, stale: true, thumbnailSelection: undefined };
    }
    if (lastExport.value.createdAt >= input.createdAt) {
      return { lastExport, stale: true, thumbnailSelection: undefined };
    }
    const facts = yield* readThumbnailFacts(input.videoId);
    if (facts.selection !== undefined && facts.selection.selectedAt >= input.createdAt) {
      return { lastExport, stale: true, thumbnailSelection: facts.selection };
    }
    const exists = yield* (yield* VideoFiles).exists(lastExport.value.key);
    return { lastExport, stale: !exists, thumbnailSelection: facts.selection };
  });

/**
 * 実行の直前の検査(獲得・アダプタの入力を整える前の最後の読み取り。issue #553 論点 3)で読んだ、
 * 送信前処理が再利用する事実(P3)。チェック対象と使用対象の不一致を避けるため、各アダプタの
 * 送信前処理(prepareYouTubePost / prepareXPost)はこれらを再び読み直さない。準備できていた
 * (None でない)ときの検査結果そのものなので、lastExport は Option を解いた形で持つ。
 */
export interface ReadyFacts {
  readonly lastExport: CutExport;
  readonly thumbnailSelection: ThumbnailSelection | undefined;
}

export interface PostReadinessCheck {
  /** P3: 送信前処理（due-posts.ts）が再利用する、検査で読んだ最後の書き出し。再び読み直さない。 */
  readonly lastExport: Option.Option<CutExport>;
  readonly readiness: PostReadiness;
  /** P3: 送信前処理が再利用する、検査で読んだサムネイルの選択。再び読み直さない。 */
  readonly thumbnailSelection: ThumbnailSelection | undefined;
}

/** 実行の直前の検査。判断（優先順位）は post-state.ts に置き、ここは結果（と、検査で読んだ事実）を返すだけ。 */
export const checkPostReadiness = (
  input: ReadinessInput,
): Effect.Effect<
  PostReadinessCheck,
  AccountsDeclarationInvalid | CredentialStoreFailure,
  CredentialStore | DeclaredAccounts | SqlClient.SqlClient | VideoFiles
> =>
  Effect.gen(function* () {
    const accountMismatch = yield* checkAccountMismatch(input);
    const staleCheck = yield* checkStaleFacts(input);
    return {
      lastExport: staleCheck.lastExport,
      readiness: { accountMismatch, staleFacts: staleCheck.stale },
      thumbnailSelection: staleCheck.thumbnailSelection,
    };
  });
