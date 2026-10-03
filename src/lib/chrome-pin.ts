// 初回の実行時にダウンロードする chrome-headless-shell の版。CI の cache の鍵もこの値から作る（取り出しは CI の chrome-pin step）。
// 更新するときは `resolveBuildId(Browser.CHROMEHEADLESSSHELL, platform, "stable")` で得た値に置き換える。
export const chromeHeadlessShellBuildId = "154.0.8037.92";
