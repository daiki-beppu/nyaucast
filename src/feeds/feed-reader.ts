import { Effect, Option, Result, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import { HttpUrl } from "../db/explainer-videos.ts";

/** 題材候補。記事の本文は持たず、フィードが載せている抜粋だけを持つ。 */
export const TopicCandidate = Schema.Struct({
  excerpt: Schema.optionalKey(Schema.String),
  feed: Schema.String,
  publishedAt: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  url: HttpUrl,
});
type TopicCandidate = typeof TopicCandidate.Type;

const FailureReason = Schema.Literals(["HttpStatus", "Unreachable", "InvalidFeed", "Timeout"]);
type FailureReason = typeof FailureReason.Type;

/** 取れなかったフィード。理由は安定したタグで、次に取る行動の文章は持たない。 */
export const FailedFeed = Schema.Struct({
  name: Schema.String,
  reason: FailureReason,
  status: Schema.optionalKey(Schema.Finite),
  url: Schema.String,
});
type FailedFeed = typeof FailedFeed.Type;

interface Feed {
  readonly name: string;
  readonly url: string;
}

type FeedReading =
  | { readonly candidates: readonly TopicCandidate[] }
  | { readonly failed: FailedFeed };

interface Failure {
  readonly reason: FailureReason;
  readonly status?: number;
}

const feedTimeout = "30 seconds";
const itemTags = new Set(["entry", "item", "link"]);

// 名前空間の接頭辞（rdf:RDF・dc:date）は残して引く。数値や真偽値への変換はしない。
const parser = new XMLParser({
  ignoreAttributes: false,
  isArray: (tagName) => itemTags.has(tagName),
  parseTagValue: false,
});

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** 要素の文字列。属性を持つ要素は `#text` に入る。空なら undefined。 */
const textOf = (value: unknown): string | undefined => {
  const raw = isNode(value) ? value["#text"] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
};

const firstText = (value: unknown): string | undefined => {
  for (const element of asArray(value)) {
    const text = textOf(element);
    if (text !== undefined) return text;
  }
  return undefined;
};

const resolveUrl = (raw: string, base: string): string | undefined => {
  if (URL.canParse(raw)) return raw;
  return URL.canParse(raw, base) ? new URL(raw, base).href : undefined;
};

// 候補にできる URL は http(s) だけ。相対 URL は、フィードを実際に取った URL（転送の後）を基準に解決する。
const absoluteHttpUrl = (raw: string | undefined, baseUrl: string): string | undefined => {
  const resolved = raw && resolveUrl(raw, baseUrl);
  return resolved && /^https?:/iu.test(resolved) ? resolved : undefined;
};

const isoDate = (raw: string | undefined): string | undefined => {
  const millis = Date.parse(raw ?? "");
  return Number.isNaN(millis) ? undefined : new Date(millis).toISOString();
};

interface RawItem {
  readonly excerpt: string | undefined;
  readonly link: string | undefined;
  readonly publishedAt: string | undefined;
  readonly title: string | undefined;
}

const childOf = (value: unknown, key: string): unknown => (isNode(value) ? value[key] : undefined);

// Atom の記事の URL は rel の無い link か alternate の link。self や enclosure は記事ではない。
const articleRels = new Set<unknown>([undefined, "alternate"]);
const isArticleLink = (link: unknown): link is Node =>
  isNode(link) && articleRels.has(link["@_rel"]) && typeof link["@_href"] === "string";

const atomLink = (links: unknown): string | undefined => {
  const href = asArray(links).find(isArticleLink)?.["@_href"];
  return typeof href === "string" ? href.trim() : undefined;
};

// 本文（content:encoded・Atom の content）は読まない。抜粋の要素と日時の要素だけを引く。
const readItem = (
  item: unknown,
  tags: { readonly dates: readonly string[]; readonly excerpt: string },
  link: (node: Node) => string | undefined,
): RawItem => {
  const node = isNode(item) ? item : {};
  return {
    excerpt: textOf(node[tags.excerpt]),
    link: link(node),
    publishedAt: tags.dates.map((tag) => textOf(node[tag])).find((text) => text !== undefined),
    title: textOf(node["title"]),
  };
};

const rssTags = { dates: ["pubDate", "dc:date"], excerpt: "description" } as const;
const atomTags = { dates: ["published", "updated"], excerpt: "summary" } as const;
const rssItem = (item: unknown) => readItem(item, rssTags, (node) => firstText(node["link"]));
const atomItem = (entry: unknown) => readItem(entry, atomTags, (node) => atomLink(node["link"]));

// ルート要素で形式を決める。RSS 2.0 は rss/channel/item、RSS 1.0 は rdf:RDF 直下の item、Atom は feed/entry。
const formats = [
  {
    items: (root: unknown) => childOf(childOf(root, "channel"), "item"),
    read: rssItem,
    root: "rss",
  },
  { items: (root: unknown) => childOf(root, "item"), read: rssItem, root: "rdf:RDF" },
  { items: (root: unknown) => childOf(root, "entry"), read: atomItem, root: "feed" },
] as const;

const rawItems = (document: Node): readonly RawItem[] | undefined => {
  const format = formats.find((candidate) => document[candidate.root] !== undefined);
  if (format === undefined) return undefined;
  return asArray(format.items(document[format.root])).map((item) => format.read(item));
};

const candidatesOf = (
  feed: Feed,
  baseUrl: string,
  items: readonly RawItem[],
): readonly TopicCandidate[] =>
  items.flatMap((item) => {
    const url = absoluteHttpUrl(item.link, baseUrl);
    if (url === undefined) return [];
    const publishedAt = isoDate(item.publishedAt);
    return [
      {
        feed: feed.name,
        url,
        ...(item.title === undefined ? {} : { title: item.title }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
        ...(item.excerpt === undefined ? {} : { excerpt: item.excerpt }),
      },
    ];
  });

const parseFeed = (
  feed: Feed,
  { baseUrl, text }: FetchedFeed,
): Result.Result<readonly TopicCandidate[], Failure> => {
  if (XMLValidator.validate(text) !== true) return Result.fail({ reason: "InvalidFeed" });
  // validate は DOCTYPE の中身を検査しない。外部実体の宣言などは parse が例外で拒否するので、ここで分類する。
  const document = Result.try({
    catch: (): Failure => ({ reason: "InvalidFeed" }),
    try: (): unknown => parser.parse(text),
  });
  return Result.flatMap(document, (parsed) => {
    const items = isNode(parsed) ? rawItems(parsed) : undefined;
    return items === undefined
      ? Result.fail<Failure>({ reason: "InvalidFeed" })
      : Result.succeed(candidatesOf(feed, baseUrl, items));
  });
};

// フィードの URL は http から https への転送や移転で 3xx を返すことが多いので、転送に従う。上限を超えたら最後の 3xx が残る。
const maxRedirects = 5;

interface FetchedFeed {
  readonly baseUrl: string;
  readonly text: string;
}

const fetchText = (http: HttpClient.HttpClient, feed: Feed) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.followRedirects(http, maxRedirects)
      .execute(HttpClientRequest.get(feed.url))
      .pipe(Effect.mapError((): Failure => ({ reason: "Unreachable" })));
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail<Failure>({ reason: "HttpStatus", status: response.status });
    }
    const text = yield* response.text.pipe(
      Effect.mapError((): Failure => ({ reason: "Unreachable" })),
    );
    return { baseUrl: response.request.url, text } satisfies FetchedFeed;
  });

const failedFeed = (feed: Feed, failure: Failure): FailedFeed => ({
  name: feed.name,
  reason: failure.reason,
  ...(failure.status === undefined ? {} : { status: failure.status }),
  url: feed.url,
});

/**
 * フィード 1 本を取って候補にする。失敗はこの関数の中で 1 回だけ分類して値として返し、呼び出し元を失敗させない。
 * 取りにいくのはフィードの URL だけで、記事の URL へは行かない。
 */
export const readFeed = Effect.fn("feeds.readFeed")(function* (feed: Feed) {
  const http = yield* HttpClient.HttpClient;
  const fetched = yield* fetchText(http, feed).pipe(
    Effect.timeoutOption(feedTimeout),
    Effect.result,
  );
  const parsed = Result.flatMap(
    Result.flatMap(fetched, (timed) =>
      Option.isSome(timed)
        ? Result.succeed(timed.value)
        : Result.fail<Failure>({ reason: "Timeout" }),
    ),
    (fetchedFeed) => parseFeed(feed, fetchedFeed),
  );
  return Result.match(parsed, {
    onFailure: (failure): FeedReading => ({ failed: failedFeed(feed, failure) }),
    onSuccess: (candidates): FeedReading => ({ candidates }),
  });
});
