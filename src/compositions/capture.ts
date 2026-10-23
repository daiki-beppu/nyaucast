import { join } from "node:path";

import { Effect, FileSystem, Schema, Stream } from "effect";

import { Chrome, ChromeUnavailable, type ChromePage } from "../lib/chrome.ts";

// ---- 時刻の規則（1e-9 は、フレームの境界ちょうどの浮動小数点の誤差を吸収する） ----

const epsilon = 1e-9;

/** 撮るフレームの数。 */
export const frameCount = (durationSeconds: number, fps: number) =>
  Math.ceil(durationSeconds * fps - epsilon);

/** i 番目のフレームの時刻。 */
export const frameTime = (index: number, fps: number) => index / fps;

interface Span {
  readonly duration: number;
  readonly start: number;
}

// segment が終わる直前のフレームの番号。終わりがフレームの境界ちょうどのときは、その 1 つ前のフレーム。
const lastFrameIndex = (segment: Span, fps: number) =>
  Math.max(0, Math.ceil((segment.start + segment.duration) * fps - epsilon) - 1);

/** segment の終わる直前のフレームの時刻。1 フレームより短い segment では、segment の開始。 */
export const segmentLastFrameTime = (segment: Span, fps: number) =>
  Math.max(segment.start, frameTime(lastFrameIndex(segment, fps), fps));

// ---- composition の契約（docs/reference/composition-contract.md） ----

const Segment = Schema.Struct({
  duration: Schema.Finite,
  start: Schema.Finite,
  static: Schema.Boolean,
});

const Hold = Schema.Struct({
  duration: Schema.Finite,
  start: Schema.Finite,
});

const Hf = Schema.Struct({
  duration: Schema.Finite,
  fps: Schema.Finite,
  height: Schema.Finite,
  holds: Schema.optionalKey(Schema.Array(Hold)),
  segments: Schema.Array(Segment),
  width: Schema.Finite,
});
export type Hf = typeof Hf.Type;

// ページから 1 発で読む申告。値の検証は規則ごとに行うので、ここでは形だけを受ける。
// 申告の項目が欠けるのは composition の契約違反（規則名で返す）であり、CDP 応答の破損ではないので、項目は省略可にする。
const RawHf = Schema.NullOr(
  Schema.Struct({
    duration: Schema.optionalKey(Schema.Unknown),
    fps: Schema.optionalKey(Schema.Unknown),
    height: Schema.optionalKey(Schema.Unknown),
    holds: Schema.optionalKey(Schema.Unknown),
    seekType: Schema.String,
    segments: Schema.optionalKey(Schema.Unknown),
    width: Schema.optionalKey(Schema.Unknown),
  }),
);
type RawHf = NonNullable<typeof RawHf.Type>;

export class InvalidComposition extends Schema.TaggedError<InvalidComposition>()(
  "InvalidComposition",
  { videoId: Schema.String, violations: Schema.Array(Schema.String) },
) {}

export class NondeterministicComposition extends Schema.TaggedError<NondeterministicComposition>()(
  "NondeterministicComposition",
  { seconds: Schema.Array(Schema.Finite), videoId: Schema.String },
) {}

/** hold の最初（代表）と最後のフレームが一致しなかった。composition の hold の申告の誤りで、seek の決定論の破れではない。 */
export class HoldMismatch extends Schema.TaggedError<HoldMismatch>()("HoldMismatch", {
  seconds: Schema.Array(Schema.Finite),
  videoId: Schema.String,
}) {}

const unless = (holds: boolean, rule: string): string[] => (holds ? [] : [rule]);

const positiveInteger = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0;
const positiveFinite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isSegments = Schema.is(Schema.Array(Segment));

const sortedByStart = (segments: readonly (typeof Segment.Type)[]) =>
  segments.toSorted((left, right) => left.start - right.start);

const isContiguous = (sorted: readonly (typeof Segment.Type)[]) =>
  sorted.every(
    (segment, index) =>
      index === sorted.length - 1 || segment.start + segment.duration === sorted[index + 1]?.start,
  );

const segmentViolations = (raw: RawHf) => {
  if (!isSegments(raw.segments) || raw.segments.length === 0) return ["segments"];
  const sorted = sortedByStart(raw.segments);
  const last = sorted[sorted.length - 1];
  return [
    ...unless(
      sorted.every((segment) => segment.start >= 0 && segment.duration > 0),
      "segments-duration",
    ),
    ...unless(sorted[0]?.start === 0, "segments-start"),
    ...unless(isContiguous(sorted), "segments-gap"),
    ...unless(last !== undefined && last.start + last.duration === raw.duration, "segments-end"),
  ];
};

// ---- holds の規則（docs/reference/composition-contract.md の「holds の規則」） ----

const isHolds = Schema.is(Schema.Array(Hold));

// 境目の比較は 1/1024 秒の格子に揃えた値で行う（浮動小数のずれで、端がちょうど境目の hold を違反にしない）。
const onGrid = (seconds: number) => Math.round(seconds * 1024) / 1024;

const gridSpan = (span: Span) => ({
  end: onGrid(span.start + span.duration),
  start: onGrid(span.start),
});

const holdsOverlap = (spans: readonly { end: number; start: number }[]) => {
  const sorted = spans.toSorted((left, right) => left.start - right.start);
  let reach = Number.NEGATIVE_INFINITY;
  for (const span of sorted) {
    if (span.start < reach) return true;
    reach = Math.max(reach, span.end);
  }
  return false;
};

interface GridSpan {
  readonly end: number;
  readonly start: number;
}
interface GridSegment extends GridSpan {
  readonly static: boolean;
}

const holdsWithinSegments = (holds: readonly GridSpan[], segments: readonly GridSegment[]) =>
  holds.every((hold) =>
    segments.some((segment) => hold.start >= segment.start && hold.end <= segment.end),
  );

const holdsOutsideStatic = (holds: readonly GridSpan[], segments: readonly GridSegment[]) =>
  !holds.some((hold) =>
    segments.some(
      (segment) => segment.static && hold.start < segment.end && hold.end > segment.start,
    ),
  );

const holdsWithinComposition = (holds: readonly GridSpan[], end: number) =>
  holds.every((hold) => hold.start >= 0 && hold.end <= end);

// 比べる基準（segments）の崩れは segments として別に報告されるので、ここでは評価しない。
// segments が composition の範囲の外まで延びていても、hold の範囲は composition の範囲で別に判定する（崩れは segments-end として別に報告される）。
// duration の崩れも duration として別に報告されるので、範囲の判定はしない。
const holdSegmentViolations = (holds: readonly GridSpan[], raw: RawHf) => {
  if (!isSegments(raw.segments)) return [];
  const compositionEnd = positiveFinite(raw.duration)
    ? onGrid(raw.duration as number)
    : Number.POSITIVE_INFINITY;
  const segments = raw.segments.map((segment) => ({
    ...gridSpan(segment),
    static: segment.static,
  }));
  return [
    ...unless(
      holdsWithinSegments(holds, segments) && holdsWithinComposition(holds, compositionEnd),
      "holds-segment",
    ),
    ...unless(holdsOutsideStatic(holds, segments), "holds-static"),
  ];
};

// 2 フレームの境は格子の上にないので、格子化しない値で比べる。fps の崩れは fps として別に報告される。
const holdDurationViolations = (holds: readonly Span[], raw: RawHf) => {
  const fps = raw.fps;
  if (!positiveFinite(fps)) return [];
  return unless(
    holds.every((hold) => hold.duration * (fps as number) >= 2 - epsilon),
    "holds-duration",
  );
};

// holds が書かれていないときは何も申告していないので、規則を評価しない。
const holdViolations = (raw: RawHf) => {
  if (raw.holds === undefined) return [];
  if (!isHolds(raw.holds)) return ["holds"];
  const grid = raw.holds.map(gridSpan);
  return [
    ...holdSegmentViolations(grid, raw),
    ...unless(!holdsOverlap(grid), "holds-overlap"),
    ...holdDurationViolations(raw.holds, raw),
  ];
};

/** 契約の違反を、安定した識別子ですべて挙げる。render は撮影のレートとエンコードのレートが一致することも求める。 */
export const reviewHf = (raw: RawHf | null, encodingFps: number | undefined) => {
  if (raw === null) return ["hf-missing"];
  return [
    ...unless(positiveInteger(raw.width), "width"),
    ...unless(positiveInteger(raw.height), "height"),
    ...unless(positiveFinite(raw.fps), "fps"),
    ...unless(positiveFinite(raw.duration), "duration"),
    ...unless(raw.seekType === "function", "seek"),
    ...segmentViolations(raw),
    ...holdViolations(raw),
    ...unless(encodingFps === undefined || raw.fps === encodingFps, "fps-encoding"),
  ];
};

// ---- ページの操作 ----

const Evaluated = Schema.Struct({
  exceptionDetails: Schema.optionalKey(Schema.Unknown),
  result: Schema.Struct({ value: Schema.optionalKey(Schema.Unknown) }),
});
const Screenshot = Schema.Struct({ data: Schema.String });
const commandFailed = () => new ChromeUnavailable({ stage: "command" });

const evaluate = (page: ChromePage, expression: string, awaitPromise: boolean) =>
  Effect.gen(function* () {
    const raw = yield* page.connection.send(
      "Runtime.evaluate",
      { awaitPromise, expression, returnByValue: true },
      page.sessionId,
    );
    const evaluated = yield* Schema.decodeUnknownEffect(Evaluated)(raw).pipe(
      Effect.mapError(commandFailed),
    );
    return evaluated.exceptionDetails === undefined
      ? evaluated.result.value
      : yield* commandFailed();
  });

const readHfExpression = `(() => {
  const hf = window.__hf;
  if (!hf) return null;
  return { duration: hf.duration, fps: hf.fps, height: hf.height, holds: hf.holds, seekType: typeof hf.seek, segments: hf.segments, width: hf.width };
})()`;

// seek → settle（double rAF と 50ms の race）。settle を省くと、前の seek の絵を撮ってしまう。
const seekExpression = (seconds: number) => `(async (t) => {
  window.__hf.seek(t);
  const frame = new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const timeout = new Promise((resolve) => setTimeout(resolve, 50));
  await Promise.race([frame, timeout]);
})(${JSON.stringify(seconds)})`;

/** 時刻 t へ seek し、settle してから、そのフレームの PNG を撮る。 */
const captureAt = (page: ChromePage, seconds: number) =>
  Effect.gen(function* () {
    yield* evaluate(page, seekExpression(seconds), true);
    const raw = yield* page.connection.send(
      "Page.captureScreenshot",
      { format: "png", optimizeForSpeed: true },
      page.sessionId,
    );
    const shot = yield* Schema.decodeUnknownEffect(Screenshot)(raw).pipe(
      Effect.mapError(commandFailed),
    );
    return new Uint8Array(Buffer.from(shot.data, "base64"));
  });

// 描画は composition のファイル 1 枚で決まる。図解の契約の検査に漏れがあっても外部の状態に依存しないよう、ネットワークの要求を止める。
const blockedUrls = ["http://*", "https://*", "ws://*", "wss://*"];

const loadFile = (page: ChromePage, file: string) =>
  Effect.gen(function* () {
    yield* page.connection.send("Network.enable", {}, page.sessionId);
    yield* page.connection.send("Network.setBlockedURLs", { urls: blockedUrls }, page.sessionId);
    const loaded = yield* page.connection.expect("Page.loadEventFired", page.sessionId);
    yield* page.connection.send("Page.navigate", { url: `file://${file}` }, page.sessionId);
    yield* loaded;
  });

const setViewport = (page: ChromePage, hf: Hf) =>
  page.connection.send(
    "Emulation.setDeviceMetricsOverride",
    { deviceScaleFactor: 1, height: hf.height, mobile: false, width: hf.width },
    page.sessionId,
  );

const decodeRawHf = (value: unknown) =>
  Schema.decodeUnknownEffect(RawHf)(value).pipe(Effect.mapError(commandFailed));

export interface OpenedComposition {
  readonly hf: Hf;
  readonly page: ChromePage;
}

/**
 * composition を Chrome で開き、`window.__hf` を読んで契約を検証する。違反があれば InvalidComposition（すべての違反を挙げる）。
 * Chrome のプロセスと一時ファイルは、呼び出し側のスコープが終わると片付く。
 */
export const openComposition = (videoId: string, bytes: Uint8Array, encodingFps?: number) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "nyaucast-composition-" })
      .pipe(Effect.orDie);
    const file = join(directory, "composition.html");
    yield* fileSystem.writeFile(file, bytes).pipe(Effect.orDie);
    const page = yield* (yield* Chrome).openPage;
    yield* loadFile(page, file);
    const raw = yield* decodeRawHf(yield* evaluate(page, readHfExpression, false));
    const violations = reviewHf(raw, encodingFps);
    if (violations.length > 0) {
      return yield* new InvalidComposition({ videoId, violations });
    }
    const hf = yield* Schema.decodeUnknownEffect(Hf)(raw).pipe(Effect.mapError(commandFailed));
    yield* setViewport(page, hf);
    return { hf, page } satisfies OpenedComposition;
  });

// ---- 撮影 ----

/** 番号順に並べた segment（プレビューの番号は、この順の 1 始まり）。 */
const orderedSegments = (hf: Hf) => sortedByStart(hf.segments);

/** プレビュー: 各 segment の終わる直前のフレームの PNG を、segment の順に撮る。 */
export const capturePreviewFrames = (opened: OpenedComposition) =>
  Effect.forEach(orderedSegments(opened.hf), (segment) =>
    captureAt(opened.page, segmentLastFrameTime(segment, opened.hf.fps)),
  );

// 決定論の検証に使うフレームの番号。各 segment の終わる直前（重複と範囲外を除く）。
const sampleIndices = (hf: Hf) => {
  const count = frameCount(hf.duration, hf.fps);
  const indices = hf.segments.map((segment) =>
    Math.min(lastFrameIndex(segment, hf.fps), count - 1),
  );
  return [...new Set(indices)].toSorted((left, right) => left - right);
};

export interface FrameCapture {
  /** frames が流すフレームの数（全フレームを撮ったときと同じ）。 */
  readonly count: number;
  /** 先頭から順に撮り、static 区間のフレームには代表の画像を流すフレーム。流し終えると samples と holdMismatches が埋まる。 */
  readonly frames: Stream.Stream<Uint8Array, ChromeUnavailable>;
  /** 流し終えたあとに、最初と最後のフレームが一致しなかった hold の start（撮った順）。 */
  readonly holdMismatches: readonly number[];
  /** 決定論の検証用に控えた、segment の終わる直前のフレーム（番号 → PNG。static 区間の中は代表の PNG）。 */
  readonly samples: ReadonlyMap<number, Uint8Array>;
}

// ---- static 区間（static: true の segment と hold）のフレームの範囲 ----

interface StaticInterval {
  readonly first: number;
  readonly isHold: boolean;
  readonly last: number;
  readonly start: number;
}

interface FrameRange {
  readonly first: number;
  readonly last: number;
}

// 区間 [start, end) に時刻が入るフレームの範囲（frameCount / lastFrameIndex と同じ規則）。
const frameRange = (span: Span, fps: number, count: number): FrameRange => ({
  first: Math.max(0, Math.ceil(span.start * fps - epsilon)),
  last: Math.min(count - 1, Math.ceil((span.start + span.duration) * fps - epsilon) - 1),
});

// hold の検証は 1/1024 秒の格子で行うので、元の値では終わりが segment の終わりをわずかに越えうる。
// 次の segment のフレームを代表の絵で置き換えないよう、hold を収める segment の範囲で切る。
const holdInterval = (hold: Span, hf: Hf, count: number): StaticInterval => {
  const own = frameRange(hold, hf.fps, count);
  const grid = gridSpan(hold);
  const container = hf.segments.find((segment) => {
    const bounds = gridSpan(segment);
    return grid.start >= bounds.start && grid.end <= bounds.end;
  });
  const bound = container === undefined ? own : frameRange(container, hf.fps, count);
  return {
    first: Math.max(own.first, bound.first),
    isHold: true,
    last: Math.min(own.last, bound.last),
    start: hold.start,
  };
};

const staticIntervals = (hf: Hf): readonly StaticInterval[] => {
  const count = frameCount(hf.duration, hf.fps);
  const segments = hf.segments
    .filter((segment) => segment.static)
    .map((segment) => ({
      ...frameRange(segment, hf.fps, count),
      isHold: false,
      start: segment.start,
    }));
  const holds = (hf.holds ?? []).map((hold) => holdInterval(hold, hf, count));
  const sorted = [...segments, ...holds].toSorted((left, right) => left.first - right.first);
  return sorted
    .map((interval, index) => ({
      ...interval,
      // 格子の丸めで隣り合う区間が同じフレームを含みうる。フレームは次の区間のものにする。
      last: Math.min(interval.last, (sorted[index + 1]?.first ?? Number.POSITIVE_INFINITY) - 1),
    }))
    .filter((interval) => interval.first <= interval.last);
};

const integers = (from: number, until: number) =>
  Array.from({ length: Math.max(0, until - from) }, (_, offset) => from + offset);

// 撮らないフレーム: 区間の代表の次から。hold は最後のフレームを撮る（両端の比較のため）。
const skippedFrames = (interval: StaticInterval) =>
  integers(interval.first + 1, interval.isHold ? interval.last : interval.last + 1);

/** 撮るフレームの番号の列（昇順・重複なし）: static 区間の外のフレーム、各 static 区間の最初のフレーム、各 hold の最後のフレーム。 */
export const captureIndices = (hf: Hf): readonly number[] => {
  const skipped = new Set(staticIntervals(hf).flatMap(skippedFrames));
  return integers(0, frameCount(hf.duration, hf.fps)).filter((index) => !skipped.has(index));
};

/** 撮った番号ごとに、流す画像（0 枚以上）のストリームを決める。代表と控えの状態を持つので、1 回の撮影ごとに作る。 */
const frameRouter = (hf: Hf) => {
  const intervals = staticIntervals(hf);
  const wanted = sampleIndices(hf);
  const runs = new Map(intervals.map((interval) => [interval.first, interval]));
  const holdEnds = new Map(
    intervals
      .filter((interval) => interval.isHold && interval.last > interval.first)
      .map((interval) => [interval.last, interval]),
  );
  const samples = new Map<number, Uint8Array>();
  const holdMismatches: number[] = [];
  let representative: Uint8Array = new Uint8Array();

  const startRun = (run: StaticInterval, png: Uint8Array) => {
    representative = png;
    for (const index of wanted) {
      if (index >= run.first && index <= run.last) samples.set(index, png);
    }
    // 区間のフレーム数だけ代表を流す。区間長の配列は作らない。
    return Stream.range(1, run.last - run.first + 1).pipe(Stream.map(() => png));
  };

  const route = (index: number, png: Uint8Array): Stream.Stream<Uint8Array> => {
    const run = runs.get(index);
    if (run !== undefined) return startRun(run, png);
    const hold = holdEnds.get(index);
    if (hold !== undefined) {
      if (!sameBytes(representative, png)) holdMismatches.push(hold.start);
      return Stream.empty;
    }
    if (wanted.includes(index)) samples.set(index, png);
    return Stream.succeed(png);
  };

  return { holdMismatches, route, samples };
};

/** 撮るフレームの列（captureIndices）を時刻 i / fps で順に撮り、全フレーム分の画像を番号順に流す。 */
export const captureFrames = ({ hf, page }: OpenedComposition): FrameCapture => {
  const { holdMismatches, route, samples } = frameRouter(hf);
  const frames = Stream.fromIterable(captureIndices(hf)).pipe(
    Stream.mapEffect((index) =>
      captureAt(page, frameTime(index, hf.fps)).pipe(Effect.map((png) => route(index, png))),
    ),
    Stream.flatMap((pngs) => pngs),
  );
  return { count: frameCount(hf.duration, hf.fps), frames, holdMismatches, samples };
};

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  Buffer.from(left).equals(Buffer.from(right));

/** seek の純関数性の検証: 控えたフレームの時刻へ（逆順に）再 seek して撮り、バイトを比べる。一致しなかった時刻を返す。 */
export const reseekMismatches = (
  opened: OpenedComposition,
  samples: ReadonlyMap<number, Uint8Array>,
) =>
  Effect.forEach([...samples.keys()].toReversed(), (index) =>
    captureAt(opened.page, frameTime(index, opened.hf.fps)).pipe(
      Effect.map((png) =>
        sameBytes(png, samples.get(index) ?? new Uint8Array())
          ? []
          : [frameTime(index, opened.hf.fps)],
      ),
    ),
  ).pipe(Effect.map((groups) => groups.flat().toSorted((left, right) => left - right)));
