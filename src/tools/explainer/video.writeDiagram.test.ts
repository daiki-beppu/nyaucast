import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  diagramKey,
  explainerConfigWithTheme,
  sceneOneDiagram,
  scriptScenes,
} from "../../../test/composition-helpers.ts";
import { accepts, failureFacts, publishedAdditionalProperties } from "../../../test/helpers.ts";
import {
  approveProduce,
  recordPlan,
  rejectProduce,
  scriptInput,
  tableRowCounts,
} from "../../../test/narration-helpers.ts";
import { channelFileExists, readChannelFile } from "../../../test/thumbnail-helpers.ts";
import { shortDiagramKey, withdrawShort, writeShort } from "../../../test/short-helpers.ts";
import { callTool, rejectionReason, withToolChannel } from "../../../test/tool-helpers.ts";
import { ExplainerVideoWriteDiagramTool } from "./video.writeDiagram.ts";

// 台本: シーン 1 は段落 2 つ（1 句・3 句）、シーン 2 は段落 2 つ（1 句・2 句）。
interface ChannelOptions {
  /** 承認しない。 */
  readonly unapproved?: boolean;
  /** 台本を書かない。 */
  readonly withoutScript?: boolean;
}

const inChannel = <A, E, R>(
  prefix: string,
  options: ChannelOptions,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
) =>
  withToolChannel(prefix, { config: explainerConfigWithTheme() }, (channelRoot) =>
    Effect.gen(function* () {
      yield* recordPlan();
      if (options.unapproved !== true) yield* approveProduce();
      if (options.unapproved !== true && options.withoutScript !== true) {
        yield* callTool("video_write_script", scriptInput(scriptScenes));
      }
      return yield* use(channelRoot);
    }),
  );

const writeDiagram = (html: string, scene = 1) =>
  callTool("video_write_diagram", { html, scene, videoId: "V1" });

interface Violation {
  readonly rule: string;
  readonly scene: number;
}

const violationsOf = (html: string, scene = 1) =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(writeDiagram(html, scene));
    assert.strictEqual(failure._tag, "InvalidDiagrams");
    assert.strictEqual(failureFacts(failure)["videoId"], "V1");
    return failureFacts(failure)["violations"] as readonly Violation[];
  });

const readDiagram = (channelRoot: string, scene = 1) =>
  new TextDecoder().decode(readChannelFile(channelRoot, diagramKey(scene)));

describe("video.writeDiagram: parameters", () => {
  it("is named with its wire name", () => {
    assert.strictEqual(ExplainerVideoWriteDiagramTool.name, "video_write_diagram");
  });

  it("accepts a video, a scene and the html, and rejects every other key", () => {
    const schema = ExplainerVideoWriteDiagramTool.parametersSchema;

    assert.isTrue(accepts(schema, { html: "<div/>", scene: 1, videoId: "V1" }));
    assert.isFalse(accepts(schema, { html: "<div/>", scene: 1 }));
    assert.isFalse(accepts(schema, { scene: 1, videoId: "V1" }));
    assert.isFalse(accepts(schema, { html: "<div/>", videoId: "V1" }));
    assert.isFalse(accepts(schema, { force: true, html: "<div/>", scene: 1, videoId: "V1" }));
    assert.isFalse(accepts(schema, { html: "<div/>", scene: 1, seconds: 3, videoId: "V1" }));
    assert.strictEqual(publishedAdditionalProperties(ExplainerVideoWriteDiagramTool), false);
  });

  it.each([0, -1, 1.5])("does not accept the scene %j (a positive integer from 1)", (scene) => {
    assert.isFalse(
      accepts(ExplainerVideoWriteDiagramTool.parametersSchema, {
        html: "<div/>",
        scene,
        videoId: "V1",
      }),
    );
  });

  it.effect("rejects an unknown key as invalid parameters, before the diagram is written", () =>
    inChannel("nyaucast-diagram-unknown-key-", {}, (channelRoot) =>
      Effect.gen(function* () {
        const request = { html: sceneOneDiagram, scene: 1, seconds: 3, videoId: "V1" };

        assert.strictEqual(
          yield* rejectionReason("video_write_diagram", request),
          "ToolParameterValidationError",
        );
        assert.isFalse(channelFileExists(channelRoot, diagramKey(1)));
      }),
    ),
  );
});

describe("video.writeDiagram: writing a valid diagram", () => {
  it.effect("writes the diagram of the scene under the video's directory and returns the key", () =>
    inChannel("nyaucast-diagram-write-", {}, (channelRoot) =>
      Effect.gen(function* () {
        const result = yield* writeDiagram(sceneOneDiagram);

        assert.deepStrictEqual(result, { key: diagramKey(1), scene: 1, videoId: "V1" });
        assert.isTrue(channelFileExists(channelRoot, diagramKey(1)));
        assert.include(readDiagram(channelRoot), 'data-beat="2.3"');
        assert.isFalse(channelFileExists(channelRoot, diagramKey(2)));
      }),
    ),
  );

  it.effect("writes each scene to its own file", () =>
    inChannel("nyaucast-diagram-scenes-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeDiagram(sceneOneDiagram, 1);
        yield* writeDiagram(
          '<div><p data-beat="2.1">始まり</p><p data-beat="2.2">続き</p></div>',
          2,
        );

        assert.include(readDiagram(channelRoot, 1), "見出し");
        assert.include(readDiagram(channelRoot, 2), "始まり");
      }),
    ),
  );

  it.effect("writing a scene again replaces its diagram, and adds no row to the local store", () =>
    inChannel("nyaucast-diagram-replace-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeDiagram(sceneOneDiagram);
        const before = yield* tableRowCounts;

        yield* writeDiagram('<div><p data-beat="1">差し替え</p></div>');

        assert.include(readDiagram(channelRoot), "差し替え");
        assert.notInclude(readDiagram(channelRoot), "見出し");
        assert.deepStrictEqual(yield* tableRowCounts, before);
      }),
    ),
  );

  it.effect("does not need the theme: a channel without a theme can write diagrams", () =>
    inChannel("nyaucast-diagram-no-theme-", {}, () =>
      Effect.gen(function* () {
        const result = yield* writeDiagram(sceneOneDiagram);

        assert.strictEqual(result.key, diagramKey(1));
      }),
    ),
  );

  it.effect.each([
    ["a comment", '<div><!-- <script> data-beat="9" --><p>本文</p></div>'],
    ["a CDATA section", '<div><p><![CDATA[<script>alert(1)</script> data-beat="9"]]></p></div>'],
    ["escaped markup in the text", "<div><p>&lt;script&gt;alert(1)&lt;/script&gt;</p></div>"],
    ["url( in the text", "<div><p>background: url(https://example.com/a.png)</p></div>"],
    [
      "the five XML entities and numeric references",
      "<div><p>&amp; &lt; &gt; &quot; &apos; &#169; &#xA9;</p></div>",
    ],
    [
      "an internal reference and an inline image",
      '<svg><use href="#a"/><image href="data:image/png;base64,AAAA"/></svg>',
    ],
    ["inline candidates in a srcset", '<img srcset="data:image/png;base64,AAAA 1x, #a 2x"/>'],
    ["a fill that points inside the document", '<svg><rect fill="url(#grad)" id="rect"/></svg>'],
    ["CSS that is not an animation", '<div style="color: red; opacity: 0.5"></div>'],
    [
      "a CSS escape in a string, and one outside the code points",
      `<div style="content: '\\201C\\FFFFFF'"></div>`,
    ],
    [
      "an external url() that is written as text inside a string",
      `<div style="content: 'url(https://example.com/a.png)'"></div>`,
    ],
    [
      "an animation that an escape only makes inside a string",
      `<div style="content: ';\\61nimation: spin 1s'"></div>`,
    ],
    [
      "an external url() that an escape only makes inside a string",
      `<div style="content: '\\75rl(https://example.com/a.png)'"></div>`,
    ],
    [
      "a transition that only appears in a CSS comment",
      '<div style="color: red; /* transition: opacity 1s */"></div>',
    ],
    [
      "an image-set() of inline images only",
      `<div style="background-image: image-set('data:image/png;base64,AAAA' 1x, url(#a) 2x)"></div>`,
    ],
    [
      "image-set( written as text inside a string",
      `<div style="content: 'image-set(&quot;https://example.com/a.png&quot; 1x)'"></div>`,
    ],
    ["a slide with a direction", '<div data-beat="1" data-enter="slide" data-from="top"></div>'],
  ] as const)("accepts %s (it is not what the rules look at)", ([, html]) =>
    inChannel("nyaucast-diagram-benign-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeDiagram(html);

        assert.isTrue(channelFileExists(channelRoot, diagramKey(1)));
      }),
    ),
  );
});

// 1 つの規則に 1 件だけ触れる図解。どれも 1 回の失敗に、その規則の違反だけが入る。
const oneViolation: readonly (readonly [string, string, readonly string[]])[] = [
  ["a script element", "<div><script>go()</script></div>", ["forbidden-element"]],
  ["a script element in capitals", "<div><Script>go()</Script></div>", ["forbidden-element"]],
  [
    "a script element with a namespace prefix",
    "<div><svg:script>go()</svg:script></div>",
    ["forbidden-element"],
  ],
  ["a script element inside an svg", "<svg><script>go()</script></svg>", ["forbidden-element"]],
  ["a style element", "<div><style>p { color: red }</style></div>", ["forbidden-element"]],
  ["an iframe", "<div><iframe></iframe></div>", ["forbidden-element"]],
  ["a link", '<div><link rel="stylesheet"/></div>', ["forbidden-element"]],
  ["an audio element", "<div><audio></audio></div>", ["forbidden-element"]],
  ["a body element", "<div><body></body></div>", ["forbidden-element"]],
  ["an svg animate element", '<svg><animate attributeName="x"/></svg>', ["forbidden-element"]],
  ["an svg set element", '<svg><set attributeName="x"/></svg>', ["forbidden-element"]],
  ["a processing instruction", '<div><?php echo "x" ?></div>', ["forbidden-element"]],
  ["an event handler attribute", '<div onclick="go()"></div>', ["event-handler"]],
  ["an event handler attribute in mixed case", '<div onClick="go()"></div>', ["event-handler"]],
  ["an event handler on an svg element", '<svg><rect onload="go()"/></svg>', ["event-handler"]],
  ["an external image", '<img src="https://example.com/a.png"/>', ["external-reference"]],
  ["a javascript: link", '<a href="javascript:go()">x</a>', ["external-reference"]],
  [
    "a protocol-relative reference",
    '<svg><use href="//cdn.example.com/a.svg#x"/></svg>',
    ["external-reference"],
  ],
  [
    "a namespaced external reference",
    '<svg><use xlink:href="https://example.com/a.svg"/></svg>',
    ["external-reference"],
  ],
  ["a non-image data URL", '<img src="data:text/html;base64,AAAA"/>', ["external-reference"]],
  ["an external srcset", '<img srcset="https://example.com/a.png 1x"/>', ["external-reference"]],
  [
    "an external candidate after an inline one in a srcset",
    '<img srcset="data:image/png;base64,AAAA 1x, https://example.com/a.png 2x"/>',
    ["external-reference"],
  ],
  [
    "an external url() in a style, in capitals",
    `<div style='background: URL( "https://example.com/a.png")'></div>`,
    ["external-reference"],
  ],
  [
    "a protocol-relative url() in a style",
    '<div style="background:url(//cdn.example.com/a.png)"></div>',
    ["external-reference"],
  ],
  [
    "an external url() in a presentation attribute",
    '<svg><rect fill="url(https://example.com/p)"/></svg>',
    ["external-reference"],
  ],
  [
    "an external bare string in image-set()",
    `<div style='background-image: image-set("https://example.com/a.png" 1x)'></div>`,
    ["external-reference"],
  ],
  [
    "an external bare string in -webkit-image-set() after an inline one",
    `<div style="background-image: -webkit-image-set('data:image/png;base64,AAAA' 1x, '//cdn.example.com/a.png' 2x)"></div>`,
    ["external-reference"],
  ],
  [
    "an external bare string in image-set() whose name is written with an escape",
    `<div style='background-image: \\69mage-set("https://example.com/a.png" 1x)'></div>`,
    ["external-reference"],
  ],
  ["a CSS animation", '<div style="animation: spin 1s infinite"></div>', ["wall-clock-animation"]],
  ["a CSS transition", '<div style="transition: opacity 1s"></div>', ["wall-clock-animation"]],
  [
    "a CSS transition after an empty comment",
    '<div style="opacity:0;/**/transition:opacity 1s"></div>',
    ["wall-clock-animation"],
  ],
  [
    "a CSS animation whose name is written with an escape",
    '<div style="\\61nimation: spin 1s infinite"></div>',
    ["wall-clock-animation"],
  ],
  [
    "a CSS transition whose name is written with an escape and a space",
    '<div style="\\0074ransition : opacity 1s"></div>',
    ["wall-clock-animation"],
  ],
  [
    "an external url() whose name is written with an escape",
    '<div style="background: \\75rl(https://example.com/a.png)"></div>',
    ["external-reference"],
  ],
  [
    "a CSS animation after a string that only looks like the start of a comment",
    "<div style='content: \"/*\"; animation: spin 1s'></div>",
    ["wall-clock-animation"],
  ],
  [
    "a CSS animation after a comment",
    '<div style="/* x */animation: spin 1s"></div>',
    ["wall-clock-animation"],
  ],
  [
    "a CSS animation after a comment that is never closed",
    '<div style="color: red; /* x */ animation: spin 1s; /* open"></div>',
    ["wall-clock-animation"],
  ],
  [
    "a CSS animation property in capitals",
    '<div style="ANIMATION-NAME: x"></div>',
    ["wall-clock-animation"],
  ],
  [
    "an animation among other properties",
    '<div style="color: red; animation-delay: 1s"></div>',
    ["wall-clock-animation"],
  ],
  ["a data attribute outside the vocabulary", '<div data-foo="1"></div>', ["unknown-attribute"]],
  ["a near miss of a vocabulary word", '<div data-beats="1"></div>', ["unknown-attribute"]],
  [
    "a generated attribute (data-nc-motion)",
    '<div data-nc-motion="0"></div>',
    ["unknown-attribute"],
  ],
  ["a generated attribute (data-nc-scene)", '<div data-nc-scene="1"></div>', ["unknown-attribute"]],
  ["a beat of 0", '<div data-beat="0"></div>', ["invalid-position"]],
  ["a beat of 1.0", '<div data-beat="1.0"></div>', ["invalid-position"]],
  ["a beat with a leading zero", '<div data-beat="02"></div>', ["invalid-position"]],
  ["a beat that is not a number", '<div data-beat="a"></div>', ["invalid-position"]],
  ["a beat with three parts", '<div data-beat="1.2.3"></div>', ["invalid-position"]],
  ["an empty beat", '<div data-beat=""></div>', ["invalid-position"]],
  ["a negative beat", '<div data-beat="-1"></div>', ["invalid-position"]],
  ["a beat in exponent notation", '<div data-beat="1e3"></div>', ["invalid-position"]],
  ["a dim that is not a position", '<div data-dim="x"></div>', ["invalid-position"]],
  ["a paragraph that does not exist", '<div data-beat="3"></div>', ["position-out-of-range"]],
  [
    "a phrase that does not exist (paragraph 1 has one)",
    '<div data-beat="1.2"></div>',
    ["position-out-of-range"],
  ],
  ["a phrase past the last one", '<div data-beat="2.4"></div>', ["position-out-of-range"]],
  [
    "a huge paragraph number",
    '<div data-beat="999999999999999999999"></div>',
    ["position-out-of-range"],
  ],
  [
    "a huge phrase number",
    '<div data-beat="2.999999999999999999999"></div>',
    ["position-out-of-range"],
  ],
  ["a dim that is out of range", '<div data-dim="3"></div>', ["position-out-of-range"]],
  [
    "an attribute name in capitals (the range still applies)",
    '<div data-BEAT="99"></div>',
    ["position-out-of-range"],
  ],
  [
    "a paragraph and its first phrase at once",
    '<div><p data-beat="2"></p><p data-beat="2.1"></p></div>',
    ["simultaneous-motion"],
  ],
  [
    "two beats at the same phrase",
    '<div><p data-beat="2.2"></p><p data-beat="2.2"></p></div>',
    ["simultaneous-motion"],
  ],
  [
    "a beat and a dim at the same place",
    '<div><p data-beat="1"></p><p data-dim="1.1"></p></div>',
    ["simultaneous-motion"],
  ],
  ["an unknown enter", '<div data-beat="1" data-enter="zoom"></div>', ["invalid-enter"]],
  ["an enter without a beat", '<div data-enter="fade"></div>', ["invalid-enter"]],
  [
    "an unknown direction",
    '<div data-beat="1" data-enter="slide" data-from="up"></div>',
    ["invalid-from"],
  ],
  [
    "a direction on a fade",
    '<div data-beat="1" data-enter="fade" data-from="left"></div>',
    ["invalid-from"],
  ],
  ["a slide without a direction", '<div data-beat="1" data-enter="slide"></div>', ["invalid-from"]],
  [
    "a direction on the default enter",
    '<div data-beat="1" data-from="left"></div>',
    ["invalid-from"],
  ],
  [
    "a dim before the beat of the same element",
    '<div data-beat="2.3" data-dim="2.2"></div>',
    ["dim-not-after-beat"],
  ],
  ["an id that is reserved", '<div id="nc-caption"></div>', ["reserved-name"]],
  ["an id with the reserved prefix", '<div id="nc-x"></div>', ["reserved-name"]],
  ["a class that is reserved", '<div class="nc-scene"></div>', ["reserved-name"]],
  [
    "a class among others with the reserved prefix",
    '<div class="a nc-b"></div>',
    ["reserved-name"],
  ],
  ["an element that is not closed", "<div><p>text</div>", ["malformed"]],
  ["a root that is never closed", "<div>", ["malformed"]],
  ["a closing tag with no opening", "<div></span></div>", ["malformed"]],
  ["an attribute given twice", '<div a="1" a="2"></div>', ["malformed"]],
  [
    "an attribute given twice, differing only by case",
    '<div data-beat="1" DATA-BEAT="2"></div>',
    ["malformed"],
  ],
  ["a named entity outside the five of XML", "<div><p>a&nbsp;b</p></div>", ["malformed"]],
];

describe("video.writeDiagram: one violation, one rule", () => {
  it.effect.each(oneViolation)("fails for %s", ([, html, rules]) =>
    inChannel("nyaucast-diagram-rule-", {}, (channelRoot) =>
      Effect.gen(function* () {
        const violations = yield* violationsOf(html);

        assert.deepStrictEqual(
          violations.map((violation) => violation.rule),
          rules,
        );
        assert.isTrue(violations.every((violation) => violation.scene === 1));
        assert.isFalse(channelFileExists(channelRoot, diagramKey(1)));
      }),
    ),
  );

  it.effect("fails for an id used twice in the diagram", () =>
    inChannel("nyaucast-diagram-duplicate-id-", {}, () =>
      Effect.gen(function* () {
        const violations = yield* violationsOf('<div><p id="a"></p><p id="a"></p></div>');

        assert.isAtLeast(violations.length, 1);
        assert.isTrue(violations.every((violation) => violation.rule === "duplicate-id"));
      }),
    ),
  );

  it.effect("fails for a dim at the same place as the beat of its element", () =>
    inChannel("nyaucast-diagram-dim-equal-", {}, () =>
      Effect.gen(function* () {
        const violations = yield* violationsOf('<div data-beat="2.2" data-dim="2.2"></div>');

        assert.include(
          violations.map((violation) => violation.rule),
          "dim-not-after-beat",
        );
      }),
    ),
  );

  it.effect("accepts a dim after the beat and two motions at different places", () =>
    inChannel("nyaucast-diagram-ordered-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeDiagram(
          '<div><p data-beat="2.1" data-dim="2.3"></p><p data-beat="2.2"></p></div>',
        );

        assert.isTrue(channelFileExists(channelRoot, diagramKey(1)));
      }),
    ),
  );
});

describe("video.writeDiagram: every violation is listed in one failure", () => {
  it.effect("lists three violations, in document order, in a single InvalidDiagrams", () =>
    inChannel("nyaucast-diagram-three-", {}, (channelRoot) =>
      Effect.gen(function* () {
        const html =
          "<div><script>go()</script>" +
          '<p data-beat="7"></p><p data-beat="2"></p><p data-beat="2.1"></p></div>';

        const violations = yield* violationsOf(html);

        assert.deepStrictEqual(
          violations.map((violation) => [violation.scene, violation.rule]),
          [
            [1, "forbidden-element"],
            [1, "position-out-of-range"],
            [1, "simultaneous-motion"],
          ],
        );
        assert.isFalse(channelFileExists(channelRoot, diagramKey(1)));
      }),
    ),
  );

  it.effect("lists violations of different kinds on one element, not only the first", () =>
    inChannel("nyaucast-diagram-one-element-", {}, () =>
      Effect.gen(function* () {
        const violations = yield* violationsOf(
          '<div onclick="go()" data-foo="1" style="animation: x 1s"></div>',
        );

        assert.deepStrictEqual(violations.map((violation) => violation.rule).toSorted(), [
          "event-handler",
          "unknown-attribute",
          "wall-clock-animation",
        ]);
      }),
    ),
  );

  it.effect("reports a markup that is not well formed as one violation, and nothing else", () =>
    inChannel("nyaucast-diagram-malformed-", {}, () =>
      Effect.gen(function* () {
        const violations = yield* violationsOf('<div><script>go()<p data-beat="9"></div>');

        assert.deepStrictEqual(
          violations.map((violation) => violation.rule),
          ["malformed"],
        );
      }),
    ),
  );

  it.effect("keeps the diagram that was written before when a new one is rejected", () =>
    inChannel("nyaucast-diagram-keep-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeDiagram(sceneOneDiagram);
        const before = readDiagram(channelRoot);

        yield* violationsOf("<div><script>go()</script></div>");

        assert.strictEqual(readDiagram(channelRoot), before);
      }),
    ),
  );
});

describe("video.writeDiagram: preconditions", () => {
  it.effect("fails with ProduceGateNotApproved before the produce gate is approved", () =>
    inChannel("nyaucast-diagram-unapproved-", { unapproved: true }, (channelRoot) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(writeDiagram(sceneOneDiagram));

        assert.strictEqual(failure._tag, "ProduceGateNotApproved");
        assert.isFalse(channelFileExists(channelRoot, diagramKey(1)));
      }),
    ),
  );

  it.effect("fails with VideoNotFound for an unknown video", () =>
    inChannel("nyaucast-diagram-unknown-video-", {}, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          callTool("video_write_diagram", { html: sceneOneDiagram, scene: 1, videoId: "nope" }),
        );

        assert.strictEqual(failure._tag, "VideoNotFound");
      }),
    ),
  );

  it.effect("fails with ScriptNotFound when the video has no script yet", () =>
    inChannel("nyaucast-diagram-no-script-", { withoutScript: true }, (channelRoot) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(writeDiagram(sceneOneDiagram));

        assert.strictEqual(failure._tag, "ScriptNotFound");
        assert.isFalse(channelFileExists(channelRoot, diagramKey(1)));
      }),
    ),
  );

  it.effect("fails with SceneNotFound for a scene the script does not have", () =>
    inChannel("nyaucast-diagram-no-scene-", {}, (channelRoot) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(writeDiagram(sceneOneDiagram, 3));

        assert.strictEqual(failure._tag, "SceneNotFound");
        assert.strictEqual(failureFacts(failure)["videoId"], "V1");
        assert.strictEqual(failureFacts(failure)["scene"], 3);
        assert.isFalse(channelFileExists(channelRoot, diagramKey(3)));
      }),
    ),
  );

  it.effect("judges the positions by the paragraphs and phrases of the scene being written", () =>
    inChannel("nyaucast-diagram-scene-shape-", {}, () =>
      Effect.gen(function* () {
        // シーン 2 の段落 2 は 2 句。シーン 1 の段落 2 は 3 句なので、2.3 はシーン 1 でだけ正しい。
        const sceneTwo = yield* violationsOf('<div data-beat="2.3"></div>', 2);
        yield* writeDiagram('<div data-beat="2.3"></div>', 1);

        assert.deepStrictEqual(
          sceneTwo.map((violation) => [violation.scene, violation.rule]),
          [[2, "position-out-of-range"]],
        );
      }),
    ),
  );
});

// ---- 専用ショートの図解（#550）----
// 契約（この issue の計画 C6・C8）:
//   パラメータに short?（候補の番号）が増える。付けると、図解は shorts/<n>/scenes/<scene>.html に書き、
//   シーンと beat の位置は、長尺の台本ではなく、その候補の専用ショートの台本の段落・句で検査する。
//   候補が無い・取り下げ済みなら ShortCandidateNotFound。短くない図解（short なし）の動きは変わらない。

const writeShortDiagram = (html: string, scene = 1, short = 1) =>
  callTool("video_write_diagram", { html, scene, short, videoId: "V1" });

describe("video.writeDiagram: the dedicated short's diagrams", () => {
  const schema = ExplainerVideoWriteDiagramTool.parametersSchema;
  const base = { html: "<div/>", scene: 1, videoId: "V1" };

  it("accepts an optional short number, and rejects what is not a positive safe integer", () => {
    assert.isTrue(accepts(schema, { ...base, short: 1 }));
    assert.isTrue(accepts(schema, { ...base, short: Number.MAX_SAFE_INTEGER }));
    for (const short of [0, -1, 1.5, 9_007_199_254_740_992, "1"]) {
      assert.isFalse(accepts(schema, { ...base, short }));
    }
  });

  it("describes the short failure tag", () => {
    assert.include(ExplainerVideoWriteDiagramTool.description, "ShortCandidateNotFound");
  });

  it.effect("writes the diagram under the short's scenes directory and returns that key", () =>
    inChannel("nyaucast-diagram-short-write-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeShort();

        const result = yield* writeShortDiagram('<div><p data-beat="1">窓辺</p></div>', 2);

        assert.strictEqual(result.key, shortDiagramKey(1, 2));
        assert.strictEqual(result.scene, 2);
        assert.strictEqual(result.videoId, "V1");
        assert.include(
          new TextDecoder().decode(readChannelFile(channelRoot, shortDiagramKey(1, 2))),
          "窓辺",
        );
        assert.isFalse(channelFileExists(channelRoot, diagramKey(2)));
      }),
    ),
  );

  it.effect("keeps each candidate's diagrams apart from the long cut's and from each other's", () =>
    inChannel("nyaucast-diagram-short-apart-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeShort({ number: 1 });
        yield* writeShort({ number: 2 });
        yield* writeDiagram(sceneOneDiagram, 1);

        yield* writeShortDiagram('<div><p data-beat="1">一つ目の候補</p></div>', 1, 1);
        yield* writeShortDiagram('<div><p data-beat="1">二つ目の候補</p></div>', 1, 2);

        assert.include(readDiagram(channelRoot, 1), "見出し");
        const read = (number: number) =>
          new TextDecoder().decode(readChannelFile(channelRoot, shortDiagramKey(number, 1)));
        assert.include(read(1), "一つ目の候補");
        assert.include(read(2), "二つ目の候補");
      }),
    ),
  );

  it.effect("writing a short scene again replaces it, and adds no row to the local store", () =>
    inChannel("nyaucast-diagram-short-replace-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeShort();
        yield* writeShortDiagram('<div><p data-beat="1">最初</p></div>');
        const before = yield* tableRowCounts;

        yield* writeShortDiagram('<div><p data-beat="1">差し替え</p></div>');

        const written = new TextDecoder().decode(
          readChannelFile(channelRoot, shortDiagramKey(1, 1)),
        );
        assert.include(written, "差し替え");
        assert.notInclude(written, "最初");
        assert.deepStrictEqual(yield* tableRowCounts, before);
      }),
    ),
  );

  it.effect(
    "judges the scene and the positions by the dedicated script, not by the long script",
    () =>
      inChannel("nyaucast-diagram-short-judged-", {}, (channelRoot) =>
        Effect.gen(function* () {
          // 専用の台本はシーン 3 つ・各 1 段落。長尺の台本はシーン 2 つ（シーン 1 は 2 段落）。
          yield* writeShort({ scenes: [["一つ目。"], ["二つ目。"], ["三つ目。"]] });

          const thirdScene = yield* writeShortDiagram('<div><p data-beat="1">三</p></div>', 3);
          const secondParagraph = yield* Effect.flip(
            writeShortDiagram('<div><p data-beat="2">段落 2</p></div>', 1),
          );
          const noScene = yield* Effect.flip(writeShortDiagram("<div/>", 4));

          assert.strictEqual(thirdScene.key, shortDiagramKey(1, 3));
          // beat "2" は、長尺のシーン 1（2 段落）では正しいが、専用のシーン 1（1 段落）には無い位置
          assert.strictEqual(secondParagraph._tag, "InvalidDiagrams");
          assert.strictEqual(noScene._tag, "SceneNotFound");
          assert.isFalse(channelFileExists(channelRoot, shortDiagramKey(1, 4)));
          assert.isFalse(channelFileExists(channelRoot, shortDiagramKey(1, 1)));
        }),
      ),
  );

  it.effect(
    "fails with ShortCandidateNotFound for a number that was never written, and writes nothing",
    () =>
      inChannel("nyaucast-diagram-short-no-candidate-", {}, (channelRoot) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(writeShortDiagram(sceneOneDiagram, 1, 2));

          assert.strictEqual(failure._tag, "ShortCandidateNotFound");
          assert.strictEqual(failureFacts(failure)["videoId"], "V1");
          assert.strictEqual(failureFacts(failure)["number"], 2);
          assert.isFalse(channelFileExists(channelRoot, shortDiagramKey(2, 1)));
        }),
      ),
  );

  it.effect("fails with ShortCandidateNotFound for a withdrawn candidate", () =>
    inChannel("nyaucast-diagram-short-withdrawn-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeShort();
        yield* withdrawShort(1);

        const failure = yield* Effect.flip(writeShortDiagram('<div><p data-beat="1">x</p></div>'));

        assert.strictEqual(failure._tag, "ShortCandidateNotFound");
        assert.isFalse(channelFileExists(channelRoot, shortDiagramKey(1, 1)));
      }),
    ),
  );

  it.effect("fails with ProduceGateNotApproved after a NO-GO", () =>
    inChannel("nyaucast-diagram-short-rejected-", {}, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeShort();
        yield* rejectProduce();

        const failure = yield* Effect.flip(writeShortDiagram('<div><p data-beat="1">x</p></div>'));

        assert.strictEqual(failure._tag, "ProduceGateNotApproved");
        assert.isFalse(channelFileExists(channelRoot, shortDiagramKey(1, 1)));
      }),
    ),
  );
});
