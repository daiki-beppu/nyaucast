import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { HttpClientError, HttpClientRequest } from "effect/http";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import {
  collectionConfig,
  explainerConfig,
  planInput,
  source,
} from "../../test/explainer-helpers.ts";
import {
  accepts,
  publishedAdditionalProperties,
  selectAll,
  setClock,
  writeVideoConfig,
} from "../../test/helpers.ts";
import { type Routes, fakeHttp } from "../../test/sns-api.ts";
import { callTool, rejectionReason, withToolChannel } from "../../test/tool-helpers.ts";
import { ExplainerFetchTopicCandidatesTool } from "./explainer.fetchTopicCandidates.ts";

const noon = "2026-10-03T12:00:00.000Z";
const bodySentinel = "FULL_ARTICLE_BODY_SENTINEL";

const tables = [
  "approvals",
  "collections",
  "explainer_approvals",
  "explainer_plans",
  "explainer_rejections",
  "explainer_thumbnail_candidates",
  "explainer_thumbnail_exclusions",
  "explainer_thumbnail_rejections",
  "explainer_thumbnail_selections",
  "explainer_videos",
  "rejections",
  "thumbnails",
] as const;

const countAllRows = Effect.gen(function* () {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = (yield* selectAll(table)).length;
  }
  return counts;
});

const insertRejection = (videoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO explainer_rejections (video_id, gate, rejected_at) VALUES (${videoId}, 'produce', ${noon})`;
  });

const configWith = (feeds: unknown) => JSON.stringify({ ...JSON.parse(explainerConfig), feeds });

const xml = (body: string) => () =>
  new Response(body, { headers: { "content-type": "application/xml" }, status: 200 });

// hnrss の形（RSS 2.0）。description は CDATA。
const hnrss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Hacker News: Front Page</title>
    <link>https://news.ycombinator.com/</link>
    <item>
      <title>Show HN: A cat translator</title>
      <link>https://ex.com/cat</link>
      <pubDate>Fri, 03 Oct 2026 09:30:00 +0000</pubDate>
      <description><![CDATA[<p>Article URL: https://ex.com/cat</p>]]></description>
    </item>
    <item>
      <title>Second story</title>
      <link>https://ex.com/second</link>
      <pubDate>Fri, 03 Oct 2026 08:00:00 +0000</pubDate>
      <description><![CDATA[<p>Second excerpt</p>]]></description>
    </item>
  </channel>
</rss>`;

// はてなブックマークのホットエントリーの形（RSS 1.0）。本文は content:encoded に入る。
const hatena = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns="http://purl.org/rss/1.0/"
  xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel rdf:about="https://b.hatena.ne.jp/hotentry">
    <title>ホットエントリー</title>
    <link>https://b.hatena.ne.jp/hotentry</link>
  </channel>
  <item rdf:about="https://ex.jp/neko">
    <title>猫が喋る日</title>
    <link>https://ex.jp/neko</link>
    <description>猫の記事の抜粋</description>
    <dc:date>2026-10-03T18:00:00+09:00</dc:date>
    <content:encoded><![CDATA[<p>${bodySentinel}</p>]]></content:encoded>
  </item>
</rdf:RDF>`;

const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom blog</title>
  <entry>
    <title>Atom entry</title>
    <link rel="alternate" href="https://ex.com/x"/>
    <link rel="self" href="https://ex.com/feed/x"/>
    <published>2026-10-02T08:00:00Z</published>
    <updated>2026-10-02T09:00:00Z</updated>
    <summary>Atom summary</summary>
    <content type="html">${bodySentinel}</content>
  </entry>
</feed>`;

const atomLinks = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom links</title>
  <entry>
    <title>Only self and enclosure</title>
    <link rel="self" href="https://ex.com/feed/1"/>
    <link rel="enclosure" href="https://ex.com/a.mp3"/>
  </entry>
  <entry>
    <title>Plain link</title>
    <link href="https://ex.com/plain"/>
  </entry>
</feed>`;

const relativeAtom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Relative</title>
  <entry><title>Relative</title><link href="/posts/1"/></entry>
</feed>`;

const rssLinks = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>t</title>
  <item><title>No link</title></item>
  <item><title>Script link</title><link>javascript:alert(1)</link></item>
  <item><link>https://ex.com/bare</link></item>
</channel></rss>`;

const plainRss =
  '<rss version="2.0"><channel><item><title>t</title><link>https://ex.com/z</link></item></channel></rss>';

const hnroute = { feed: "GET https://hn.example/frontpage" } as const;

const feedList = [
  { name: "HN", url: "https://hn.example/frontpage" },
  { name: "Hatena", url: "https://b.example/hotentry.rss" },
] as const;

const run = (routes: Routes) => {
  const http = fakeHttp(routes);
  return {
    http,
    effect: callTool("explainer_fetch_topic_candidates", {}).pipe(Effect.provide(http.layer)),
  };
};

describe("explainer.fetchTopicCandidates: parameters and result", () => {
  it("is named with its wire name and takes no parameters", () => {
    const schema = ExplainerFetchTopicCandidatesTool.parametersSchema;

    assert.strictEqual(ExplainerFetchTopicCandidatesTool.name, "explainer_fetch_topic_candidates");
    assert.isTrue(accepts(schema, {}));
    assert.isFalse(accepts(schema, { feed: "HN" }));
    assert.strictEqual(publishedAdditionalProperties(ExplainerFetchTopicCandidatesTool), false);
  });

  it("returns the declarations, candidates and failed feeds, and rejects action fields", () => {
    const result = {
      candidates: [
        {
          excerpt: "e",
          feed: "HN",
          publishedAt: noon,
          title: "T",
          url: "https://ex.com/a",
        },
        { feed: "HN", url: "https://ex.com/b" },
      ],
      failedFeeds: [
        { name: "A", reason: "HttpStatus", status: 500, url: "https://a.example/f" },
        { name: "B", reason: "InvalidFeed", url: "https://b.example/f" },
      ],
      genre: "tech",
      hitPatterns: { shock: { description: "驚き" } },
    };
    const schema = ExplainerFetchTopicCandidatesTool.successSchema;

    assert.isTrue(accepts(schema, result));
    assert.isFalse(accepts(schema, { ...result, next: "write_plan" }));
    assert.isFalse(
      accepts(schema, {
        ...result,
        candidates: [{ ...result.candidates[0], body: "full article" }],
      }),
    );
    assert.isFalse(
      accepts(schema, {
        ...result,
        failedFeeds: [{ ...result.failedFeeds[0], reason: "NoSuchReason" }],
      }),
    );
  });
});

describe("explainer.fetchTopicCandidates: reading feeds", () => {
  it.effect("reads RSS 2.0 (CDATA description) and keeps the feed order and item order", () =>
    withToolChannel(
      "nyaucast-topics-rss2-",
      { config: configWith([{ name: "HN", url: "https://hn.example/frontpage" }]) },
      () =>
        Effect.gen(function* () {
          const { effect } = run({ [hnroute.feed]: xml(hnrss) });

          const result = yield* effect;

          assert.deepStrictEqual(result.candidates, [
            {
              excerpt: "<p>Article URL: https://ex.com/cat</p>",
              feed: "HN",
              publishedAt: "2026-10-03T09:30:00.000Z",
              title: "Show HN: A cat translator",
              url: "https://ex.com/cat",
            },
            {
              excerpt: "<p>Second excerpt</p>",
              feed: "HN",
              publishedAt: "2026-10-03T08:00:00.000Z",
              title: "Second story",
              url: "https://ex.com/second",
            },
          ]);
          assert.deepStrictEqual(result.failedFeeds, []);
        }),
    ),
  );

  it.effect("reads RSS 1.0 (rdf:RDF) with dc:date and never returns content:encoded", () =>
    withToolChannel(
      "nyaucast-topics-rss1-",
      { config: configWith([{ name: "Hatena", url: "https://b.example/hotentry.rss" }]) },
      () =>
        Effect.gen(function* () {
          const { effect } = run({ "GET https://b.example/hotentry.rss": xml(hatena) });

          const result = yield* effect;

          assert.deepStrictEqual(result.candidates, [
            {
              excerpt: "猫の記事の抜粋",
              feed: "Hatena",
              publishedAt: "2026-10-03T09:00:00.000Z",
              title: "猫が喋る日",
              url: "https://ex.jp/neko",
            },
          ]);
          assert.notInclude(JSON.stringify(result), bodySentinel);
        }),
    ),
  );

  it.effect("reads Atom: the alternate link, published and summary, and never the content", () =>
    withToolChannel(
      "nyaucast-topics-atom-",
      { config: configWith([{ name: "Blog", url: "https://blog.example/atom.xml" }]) },
      () =>
        Effect.gen(function* () {
          const { effect } = run({ "GET https://blog.example/atom.xml": xml(atom) });

          const result = yield* effect;

          assert.deepStrictEqual(result.candidates, [
            {
              excerpt: "Atom summary",
              feed: "Blog",
              publishedAt: "2026-10-02T08:00:00.000Z",
              title: "Atom entry",
              url: "https://ex.com/x",
            },
          ]);
          assert.notInclude(JSON.stringify(result), bodySentinel);
        }),
    ),
  );

  it.effect("omits the optional fields a feed item does not have", () =>
    withToolChannel(
      "nyaucast-topics-bare-",
      { config: configWith([{ name: "Bare", url: "https://bare.example/rss" }]) },
      () =>
        Effect.gen(function* () {
          const { effect } = run({ "GET https://bare.example/rss": xml(rssLinks) });

          const result = yield* effect;

          assert.deepStrictEqual(result.candidates, [{ feed: "Bare", url: "https://ex.com/bare" }]);
        }),
    ),
  );

  it.effect("resolves a relative Atom href against each feed's own URL", () =>
    withToolChannel(
      "nyaucast-topics-relative-",
      {
        config: configWith([
          { name: "Blog", url: "https://blog.example/atom.xml" },
          { name: "Other", url: "https://other.example/feed/atom.xml" },
        ]),
      },
      () =>
        Effect.gen(function* () {
          const { effect } = run({
            "GET https://blog.example/atom.xml": xml(relativeAtom),
            "GET https://other.example/feed/atom.xml": xml(relativeAtom),
          });

          const result = yield* effect;

          assert.deepStrictEqual(result.candidates, [
            { feed: "Blog", title: "Relative", url: "https://blog.example/posts/1" },
            { feed: "Other", title: "Relative", url: "https://other.example/posts/1" },
          ]);
        }),
    ),
  );

  it.effect("uses only an Atom link with no rel or rel=alternate", () =>
    withToolChannel(
      "nyaucast-topics-atom-links-",
      { config: configWith([{ name: "Links", url: "https://links.example/atom" }]) },
      () =>
        Effect.gen(function* () {
          const { effect } = run({ "GET https://links.example/atom": xml(atomLinks) });

          const result = yield* effect;

          assert.deepStrictEqual(
            result.candidates.map((candidate) => candidate.url),
            ["https://ex.com/plain"],
          );
        }),
    ),
  );

  it.effect("returns the channel's genre and hit patterns with the candidates", () =>
    withToolChannel("nyaucast-topics-declarations-", { config: configWith([]) }, () =>
      Effect.gen(function* () {
        const { effect } = run({});

        const result = yield* effect;

        assert.strictEqual(result.genre, "tech");
        assert.deepStrictEqual(result.hitPatterns, {
          contrarian: { description: "常識への反論" },
          shock: { description: "驚き" },
        });
      }),
    ),
  );

  it.effect("returns empty lists for a channel that registered no feeds, without any request", () =>
    withToolChannel("nyaucast-topics-nofeeds-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        const { effect, http } = run({});

        const result = yield* effect;

        assert.deepStrictEqual(result.candidates, []);
        assert.deepStrictEqual(result.failedFeeds, []);
        assert.deepStrictEqual(http.requests, []);
      }),
    ),
  );

  it.effect("requests only the feed URLs and never an article URL", () =>
    withToolChannel("nyaucast-topics-requests-", { config: configWith(feedList) }, () =>
      Effect.gen(function* () {
        const { effect, http } = run({
          [hnroute.feed]: xml(hnrss),
          "GET https://b.example/hotentry.rss": xml(hatena),
        });

        yield* effect;

        assert.deepStrictEqual(http.requests.map((request) => request.key).toSorted(), [
          "GET https://b.example/hotentry.rss",
          "GET https://hn.example/frontpage",
        ]);
      }),
    ),
  );

  it.effect("returns feeds' candidates in the configured feed order and keeps duplicates", () =>
    withToolChannel(
      "nyaucast-topics-order-",
      {
        config: configWith([
          { name: "First", url: "https://one.example/rss" },
          { name: "Second", url: "https://two.example/rss" },
        ]),
      },
      () =>
        Effect.gen(function* () {
          const { effect } = run({
            "GET https://one.example/rss": xml(hnrss),
            "GET https://two.example/rss": xml(hnrss),
          });

          const result = yield* effect;

          assert.deepStrictEqual(
            result.candidates.map((candidate) => [candidate.feed, candidate.url]),
            [
              ["First", "https://ex.com/cat"],
              ["First", "https://ex.com/second"],
              ["Second", "https://ex.com/cat"],
              ["Second", "https://ex.com/second"],
            ],
          );
        }),
    ),
  );
});

describe("explainer.fetchTopicCandidates: excluding sources already planned", () => {
  const dedupeFeed = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>t</title>
  <item><title>tracked</title><link>https://ex.com/a/?utm_source=x#top</link></item>
  <item><title>other query</title><link>https://ex.com/a?id=1</link></item>
  <item><title>utm in path</title><link>https://ex.com/utm_guide</link></item>
  <item><title>utm in value</title><link>https://ex.com/a?ref=utm_x</link></item>
  <item><title>secondary</title><link>https://ex.com/secondary</link></item>
</channel></rss>`;

  it.effect("drops a candidate whose normalized URL equals an existing plan's primary source", () =>
    withToolChannel(
      "nyaucast-topics-dedupe-",
      { config: configWith([{ name: "F", url: "https://f.example/rss" }]) },
      () =>
        Effect.gen(function* () {
          yield* setClock(noon);
          yield* callTool(
            "explainer_write_plan",
            planInput({
              sources: [source("https://ex.com/a"), source("https://ex.com/secondary")],
            }),
          );
          const { effect } = run({ "GET https://f.example/rss": xml(dedupeFeed) });

          const result = yield* effect;

          assert.deepStrictEqual(
            result.candidates.map((candidate) => candidate.url),
            [
              "https://ex.com/a?id=1",
              "https://ex.com/utm_guide",
              "https://ex.com/a?ref=utm_x",
              "https://ex.com/secondary",
            ],
          );
        }),
    ),
  );

  it.effect("still excludes the primary source of an abandoned video", () =>
    withToolChannel(
      "nyaucast-topics-dedupe-abandoned-",
      { config: configWith([{ name: "F", url: "https://f.example/rss" }]) },
      () =>
        Effect.gen(function* () {
          yield* setClock(noon);
          const written = yield* callTool(
            "explainer_write_plan",
            planInput({ sources: [source("https://ex.com/a")] }),
          );
          yield* insertRejection(written.videoId);
          const { effect } = run({ "GET https://f.example/rss": xml(dedupeFeed) });

          const result = yield* effect;

          assert.notInclude(
            result.candidates.map((candidate) => candidate.url),
            "https://ex.com/a/?utm_source=x#top",
          );
        }),
    ),
  );

  it.effect("only excludes the latest version's primary source of a rewritten plan", () =>
    withToolChannel(
      "nyaucast-topics-dedupe-latest-",
      { config: configWith([{ name: "F", url: "https://f.example/rss" }]) },
      () =>
        Effect.gen(function* () {
          yield* setClock(noon);
          const written = yield* callTool(
            "explainer_write_plan",
            planInput({ sources: [source("https://ex.com/a")] }),
          );
          yield* callTool(
            "explainer_write_plan",
            planInput({ sources: [source("https://ex.com/secondary")], videoId: written.videoId }),
          );
          const { effect } = run({ "GET https://f.example/rss": xml(dedupeFeed) });

          const result = yield* effect;

          assert.deepStrictEqual(
            result.candidates.map((candidate) => candidate.url),
            [
              "https://ex.com/a/?utm_source=x#top",
              "https://ex.com/a?id=1",
              "https://ex.com/utm_guide",
              "https://ex.com/a?ref=utm_x",
            ],
          );
        }),
    ),
  );

  it.effect("does not exclude by a plan recorded without sources", () =>
    withToolChannel(
      "nyaucast-topics-dedupe-title-",
      { config: configWith([{ name: "F", url: "https://f.example/rss" }]) },
      () =>
        Effect.gen(function* () {
          yield* setClock(noon);
          yield* callTool("explainer_write_plan", planInput({ title: "https://ex.com/a" }));
          const { effect } = run({ "GET https://f.example/rss": xml(dedupeFeed) });

          const result = yield* effect;

          assert.strictEqual(result.candidates.length, 5);
        }),
    ),
  );
});

describe("explainer.fetchTopicCandidates: a failing feed does not fail the call", () => {
  it.effect("returns the other feed's candidates and the failed feed with its status", () =>
    withToolChannel("nyaucast-topics-500-", { config: configWith(feedList) }, () =>
      Effect.gen(function* () {
        const { effect } = run({
          [hnroute.feed]: () => new Response("", { status: 500 }),
          "GET https://b.example/hotentry.rss": xml(hatena),
        });

        const result = yield* effect;

        assert.deepStrictEqual(
          result.candidates.map((candidate) => candidate.feed),
          ["Hatena"],
        );
        assert.deepStrictEqual(result.failedFeeds, [
          { name: "HN", reason: "HttpStatus", status: 500, url: "https://hn.example/frontpage" },
        ]);
      }),
    ),
  );

  it.effect("classifies a transport error as Unreachable", () =>
    withToolChannel("nyaucast-topics-unreachable-", { config: configWith(feedList) }, () =>
      Effect.gen(function* () {
        const { effect } = run({
          [hnroute.feed]: () =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request: HttpClientRequest.get("https://hn.example/frontpage"),
                }),
              }),
            ),
          "GET https://b.example/hotentry.rss": xml(hatena),
        });

        const result = yield* effect;

        assert.strictEqual(result.candidates.length, 1);
        assert.deepStrictEqual(result.failedFeeds, [
          { name: "HN", reason: "Unreachable", url: "https://hn.example/frontpage" },
        ]);
      }),
    ),
  );

  it.effect(
    "classifies a feed with an external entity DOCTYPE as InvalidFeed and keeps the others",
    () =>
      withToolChannel(
        "nyaucast-topics-doctype-",
        {
          config: configWith([
            { name: "Doctype", url: "https://doctype.example/rss" },
            { name: "Good", url: "https://good.example/rss" },
          ]),
        },
        () =>
          Effect.gen(function* () {
            const { effect } = run({
              "GET https://doctype.example/rss": xml(
                `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY ext SYSTEM "file:///etc/passwd">]>${plainRss}`,
              ),
              "GET https://good.example/rss": xml(hnrss),
            });

            const result = yield* effect;

            assert.deepStrictEqual(result.failedFeeds, [
              { name: "Doctype", reason: "InvalidFeed", url: "https://doctype.example/rss" },
            ]);
            assert.deepStrictEqual(
              [...new Set(result.candidates.map((candidate) => candidate.feed))],
              ["Good"],
            );
          }),
      ),
  );

  it.effect("reads the same feed without the DOCTYPE", () =>
    withToolChannel(
      "nyaucast-topics-nodoctype-",
      { config: configWith([{ name: "Doctype", url: "https://doctype.example/rss" }]) },
      () =>
        Effect.gen(function* () {
          const { effect } = run({ "GET https://doctype.example/rss": xml(plainRss) });

          const result = yield* effect;

          assert.deepStrictEqual(result.candidates, [
            { feed: "Doctype", title: "t", url: "https://ex.com/z" },
          ]);
          assert.deepStrictEqual(result.failedFeeds, []);
        }),
    ),
  );

  it.effect("classifies malformed XML and an unknown root element as InvalidFeed", () =>
    withToolChannel(
      "nyaucast-topics-invalid-",
      {
        config: configWith([
          { name: "Broken", url: "https://broken.example/rss" },
          { name: "Html", url: "https://html.example/page" },
          { name: "Good", url: "https://good.example/rss" },
        ]),
      },
      () =>
        Effect.gen(function* () {
          const { effect } = run({
            "GET https://broken.example/rss": xml(
              '<rss version="2.0"><channel><item><title>x</title><link>https://ex.com/z</link>',
            ),
            "GET https://good.example/rss": xml(hnrss),
            "GET https://html.example/page": xml("<html><body><p>not a feed</p></body></html>"),
          });

          const result = yield* effect;

          assert.deepStrictEqual(result.failedFeeds, [
            { name: "Broken", reason: "InvalidFeed", url: "https://broken.example/rss" },
            { name: "Html", reason: "InvalidFeed", url: "https://html.example/page" },
          ]);
          assert.deepStrictEqual(
            [...new Set(result.candidates.map((candidate) => candidate.feed))],
            ["Good"],
          );
        }),
    ),
  );

  it.effect("classifies a feed that never answers as Timeout after 30 seconds", () =>
    withToolChannel("nyaucast-topics-timeout-", { config: configWith(feedList) }, () =>
      Effect.gen(function* () {
        const { effect, http } = run({
          [hnroute.feed]: () => Effect.never,
          "GET https://b.example/hotentry.rss": xml(hatena),
        });

        const running = yield* Effect.forkChild(effect);
        // 設定と企画の読み出しは実 I/O なので、両方のフィードの取得が始まってから時計を進める。
        while (http.requests.length < 2) {
          yield* Effect.yieldNow;
        }
        yield* TestClock.adjust("30 seconds");
        const result = yield* Fiber.join(running);

        assert.strictEqual(result.candidates.length, 1);
        assert.deepStrictEqual(result.failedFeeds, [
          { name: "HN", reason: "Timeout", url: "https://hn.example/frontpage" },
        ]);
      }),
    ),
  );

  it.effect("returns every feed as failed, and still succeeds, when all feeds fail", () =>
    withToolChannel("nyaucast-topics-allfail-", { config: configWith(feedList) }, () =>
      Effect.gen(function* () {
        const { effect } = run({
          [hnroute.feed]: () => new Response("", { status: 500 }),
          "GET https://b.example/hotentry.rss": () => new Response("", { status: 404 }),
        });

        const result = yield* effect;

        assert.deepStrictEqual(result.candidates, []);
        assert.deepStrictEqual(
          result.failedFeeds.map((failed) => [failed.name, failed.status]),
          [
            ["HN", 500],
            ["Hatena", 404],
          ],
        );
      }),
    ),
  );
});

describe("explainer.fetchTopicCandidates: read-only", () => {
  it.effect("does not add a row to any local store table", () =>
    withToolChannel("nyaucast-topics-readonly-", { config: configWith(feedList) }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        yield* callTool(
          "explainer_write_plan",
          planInput({ sources: [source("https://ex.com/cat")] }),
        );
        const before = yield* countAllRows;
        const { effect } = run({
          [hnroute.feed]: xml(hnrss),
          "GET https://b.example/hotentry.rss": () => new Response("", { status: 500 }),
        });

        const result = yield* effect;

        assert.strictEqual(result.candidates.length, 1);
        assert.deepStrictEqual(yield* countAllRows, before);
      }),
    ),
  );
});

describe("explainer.fetchTopicCandidates: channel settings", () => {
  it.effect("fails with NotExplainerChannel when the channel kind is not explainer", () =>
    withToolChannel("nyaucast-topics-collection-", { config: collectionConfig }, () =>
      Effect.gen(function* () {
        const { effect } = run({});

        const failure = yield* Effect.flip(effect);

        assert.strictEqual(failure._tag, "NotExplainerChannel");
      }),
    ),
  );

  it.effect("fails with ChannelConfigNotFound when the channel has no video config", () =>
    withToolChannel("nyaucast-topics-noconfig-", {}, () =>
      Effect.gen(function* () {
        const { effect } = run({});

        const failure = yield* Effect.flip(effect);

        assert.strictEqual(failure._tag, "ChannelConfigNotFound");
      }),
    ),
  );

  it.effect.each([
    ["a feed URL that is not http(s)", configWith([{ name: "F", url: "file:///etc/passwd" }])],
    ["a feed without a name", configWith([{ url: "https://f.example/rss" }])],
    ["feeds that is not an array", configWith({ name: "F", url: "https://f.example/rss" })],
  ] as const)("fails with InvalidChannelConfig for %s", ([, content]) =>
    withToolChannel("nyaucast-topics-invalid-config-", { config: content }, () =>
      Effect.gen(function* () {
        const { effect } = run({});

        const failure = yield* Effect.flip(effect);

        assert.strictEqual(failure._tag, "InvalidChannelConfig");
      }),
    ),
  );

  it.effect("reads the feeds on every call, so a feed added later is fetched", () =>
    withToolChannel("nyaucast-topics-reread-", { config: configWith([]) }, (channelRoot) =>
      Effect.gen(function* () {
        const { effect: first } = run({});
        assert.deepStrictEqual((yield* first).candidates, []);

        writeVideoConfig(
          channelRoot,
          configWith([{ name: "HN", url: "https://hn.example/frontpage" }]),
        );
        const { effect: second } = run({ [hnroute.feed]: xml(hnrss) });

        assert.strictEqual((yield* second).candidates.length, 2);
      }),
    ),
  );
});

describe("explainer.fetchTopicCandidates: unknown keys", () => {
  it.effect("rejects an unknown key as invalid parameters, as the MCP entry does", () =>
    withToolChannel("nyaucast-topics-unknown-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* rejectionReason("explainer_fetch_topic_candidates", { feed: "HN" } as never),
          "ToolParameterValidationError",
        );
      }),
    ),
  );
});
