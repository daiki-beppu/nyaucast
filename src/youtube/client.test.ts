import { z, ZodError } from "zod";

import { describe, expect, test, vi } from "vite-plus/test";

import { createYouTubeClient } from "./client";

const responseSchema = z.object({ id: z.string(), title: z.string() }).strict();
const accessToken = "ACCESS_TOKEN_SENTINEL";
const uploadStartUrl = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable";
const uploadSessionUrl =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-1";

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function googleError(status: number, reasons: string[]): Response {
  return jsonResponse(
    {
      error: {
        code: status,
        errors: reasons.map((reason) => ({ message: `message for ${reason}`, reason })),
        message: "request failed",
      },
    },
    status,
  );
}

function createFixture(
  responses: Response[],
  inspectRequest?: (init?: RequestInit) => Promise<void>,
) {
  const pending = [...responses];
  const auth = {
    getAccessToken: vi.fn().mockResolvedValue(accessToken),
    refreshAccessToken: vi.fn().mockResolvedValue("REFRESHED_ACCESS_TOKEN"),
  };
  const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
    await inspectRequest?.(init);
    const response = pending.shift();
    if (response === undefined) {
      throw new Error("test response queue is empty");
    }
    return response;
  });
  const sleep = vi.fn().mockResolvedValue(undefined);
  const client = createYouTubeClient({ auth, fetch, random: () => 0, sleep });
  return { auth, client, fetch, sleep };
}

function oneShotBody(contents: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(contents));
      controller.close();
    },
  });
}

describe("YouTube REST client", () => {
  test("sends a REST request with the channel access token and parses a valid response", async () => {
    const fixture = createFixture([jsonResponse({ id: "video-1", title: "Night Drive" })]);

    await expect(
      fixture.client.request({
        channel: "deepfocus365",
        init: { method: "GET" },
        schema: responseSchema,
        url: "https://youtube.googleapis.com/youtube/v3/videos?id=video-1",
      }),
    ).resolves.toEqual({ id: "video-1", title: "Night Drive" });

    expect(fixture.fetch).toHaveBeenCalledOnce();
    const [url, init] = fixture.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://youtube.googleapis.com/youtube/v3/videos?id=video-1");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(fixture.auth.getAccessToken).toHaveBeenCalledWith("deepfocus365");
  });

  test.each([
    "https://youtube.googleapis.com.attacker.example/collect",
    "http://youtube.googleapis.com/youtube/v3/videos",
    "https://www.googleapis.com.attacker.example/upload/youtube/v3/videos",
    "http://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable",
    "https://www.googleapis.com:444/upload/youtube/v3/videos?uploadType=resumable",
    "https://www.googleapis.com/drive/v3/files",
    "https://www.googleapis.com/upload/youtube/v3/videos/extra",
  ])("rejects untrusted URL %s before accessing credentials", async (url) => {
    const fixture = createFixture([]);

    await expect(
      fixture.client.request({
        channel: "deepfocus365",
        schema: responseSchema,
        url,
      }),
    ).rejects.toThrow("https://youtube.googleapis.com");

    expect(fixture.auth.getAccessToken).not.toHaveBeenCalled();
    expect(fixture.auth.refreshAccessToken).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.sleep).not.toHaveBeenCalled();
  });

  test.each([uploadStartUrl, uploadSessionUrl])(
    "sends an authenticated request to the YouTube upload URL %s",
    async (url) => {
      const fixture = createFixture([jsonResponse({ id: "video-1", title: "Night Drive" })]);

      await expect(
        fixture.client.request({
          channel: "deepfocus365",
          init: { method: "POST" },
          schema: responseSchema,
          url,
        }),
      ).resolves.toEqual({ id: "video-1", title: "Night Drive" });

      expect(fixture.auth.getAccessToken).toHaveBeenCalledWith("deepfocus365");
      expect(fixture.fetch).toHaveBeenCalledOnce();
      const [sentUrl, init] = fixture.fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(sentUrl).toBe(url);
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
    },
  );

  test("reuses the validated upload session URL after refreshing an unauthorized token", async () => {
    const fixture = createFixture([
      googleError(401, ["authError"]),
      jsonResponse({ id: "video-1", title: "Night Drive" }),
    ]);

    await expect(
      fixture.client.request({
        channel: "deepfocus365",
        schema: responseSchema,
        url: uploadSessionUrl,
      }),
    ).resolves.toEqual({ id: "video-1", title: "Night Drive" });

    expect(fixture.auth.refreshAccessToken).toHaveBeenCalledOnce();
    expect(fixture.fetch.mock.calls.map(([url]) => url)).toEqual([
      uploadSessionUrl,
      uploadSessionUrl,
    ]);
    const [, retryInit] = fixture.fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(retryInit.headers).get("authorization")).toBe(
      "Bearer REFRESHED_ACCESS_TOKEN",
    );
  });

  test("reuses the validated upload session URL for a backoff retry", async () => {
    const fixture = createFixture([
      googleError(503, ["backendError"]),
      jsonResponse({ id: "video-1", title: "Night Drive" }),
    ]);

    await expect(
      fixture.client.request({
        channel: "deepfocus365",
        schema: responseSchema,
        url: uploadSessionUrl,
      }),
    ).resolves.toEqual({ id: "video-1", title: "Night Drive" });

    expect(fixture.sleep).toHaveBeenCalledOnce();
    expect(fixture.fetch.mock.calls.map(([url]) => url)).toEqual([
      uploadSessionUrl,
      uploadSessionUrl,
    ]);
  });

  test("fails loudly when an upload response violates the caller schema", async () => {
    const fixture = createFixture([jsonResponse({ id: "video-1" })]);

    await expect(
      fixture.client.request({
        channel: "deepfocus365",
        schema: responseSchema,
        url: uploadStartUrl,
      }),
    ).rejects.toBeInstanceOf(ZodError);

    expect(fixture.fetch).toHaveBeenCalledOnce();
    expect(fixture.sleep).not.toHaveBeenCalled();
  });

  test("keeps the validated URL for retries when the caller mutates the request", async () => {
    const allowedUrl = "https://youtube.googleapis.com/youtube/v3/videos";
    const request = {
      channel: "deepfocus365",
      schema: responseSchema,
      url: allowedUrl,
    };
    const pending = [
      googleError(503, ["backendError"]),
      jsonResponse({ id: "video-1", title: "Night Drive" }),
    ];
    const auth = {
      getAccessToken: vi.fn(async () => {
        request.url = "https://youtube.googleapis.com.attacker.example/collect";
        return accessToken;
      }),
      refreshAccessToken: vi.fn(),
    };
    const fetch = vi.fn(async (_input: string) => {
      const response = pending.shift();
      if (response === undefined) throw new Error("test response queue is empty");
      return response;
    });
    const sleep = vi.fn(async () => {
      request.url = "http://youtube.googleapis.com/youtube/v3/videos";
    });
    const client = createYouTubeClient({ auth, fetch, random: () => 0, sleep });

    await expect(client.request(request)).resolves.toEqual({
      id: "video-1",
      title: "Night Drive",
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([allowedUrl, allowedUrl]);
  });

  test("fails loudly without retrying when a successful response violates the caller schema", async () => {
    const fixture = createFixture([jsonResponse({ id: "video-1" })]);

    const request = fixture.client.request({
      channel: "deepfocus365",
      schema: responseSchema,
      url: "https://youtube.googleapis.com/youtube/v3/videos?id=video-1",
    });

    await expect(request).rejects.toBeInstanceOf(ZodError);
    expect(fixture.fetch).toHaveBeenCalledOnce();
    expect(fixture.sleep).not.toHaveBeenCalled();
  });

  test("refreshes once after an unauthorized response and retries with the refreshed token", async () => {
    const requestBodies: BodyInit[] = [];
    const requestContents: string[] = [];
    const fixture = createFixture(
      [googleError(401, ["authError"]), jsonResponse({ id: "video-1", title: "Night Drive" })],
      async (init) => {
        if (init?.body === undefined || init.body === null) throw new Error("missing request body");
        requestBodies.push(init.body);
        requestContents.push(await new Response(init.body).text());
      },
    );
    const body = vi.fn(() => oneShotBody("request-payload"));

    await expect(
      fixture.client.request({
        body,
        channel: "deepfocus365",
        init: { method: "POST" },
        schema: responseSchema,
        url: "https://youtube.googleapis.com/youtube/v3/videos?id=video-1",
      }),
    ).resolves.toEqual({ id: "video-1", title: "Night Drive" });

    expect(fixture.auth.refreshAccessToken).toHaveBeenCalledOnce();
    expect(fixture.auth.refreshAccessToken).toHaveBeenCalledWith("deepfocus365");
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    const [, secondInit] = fixture.fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(secondInit.headers).get("authorization")).toBe(
      "Bearer REFRESHED_ACCESS_TOKEN",
    );
    expect(body).toHaveBeenCalledTimes(2);
    expect(requestBodies[0]).not.toBe(requestBodies[1]);
    expect(requestContents).toEqual(["request-payload", "request-payload"]);
  });

  test.each([
    { response: () => googleError(503, ["backendError"]), status: 503 },
    { response: () => googleError(429, ["rateLimitExceeded"]), status: 429 },
    { response: () => googleError(403, ["quotaExceeded"]), status: 403 },
  ])("retries HTTP $status at exponentially increasing delays", async ({ response }) => {
    const requestBodies: BodyInit[] = [];
    const requestContents: string[] = [];
    const fixture = createFixture(
      [response(), response(), jsonResponse({ id: "video-1", title: "Night Drive" })],
      async (init) => {
        if (init?.body === undefined || init.body === null) throw new Error("missing request body");
        requestBodies.push(init.body);
        requestContents.push(await new Response(init.body).text());
      },
    );
    const body = vi.fn(() => oneShotBody("request-payload"));

    await expect(
      fixture.client.request({
        body,
        channel: "deepfocus365",
        init: { method: "POST" },
        schema: responseSchema,
        url: "https://youtube.googleapis.com/youtube/v3/videos",
      }),
    ).resolves.toEqual({ id: "video-1", title: "Night Drive" });

    expect(fixture.fetch).toHaveBeenCalledTimes(3);
    expect(fixture.sleep).toHaveBeenCalledTimes(2);
    const firstDelay = fixture.sleep.mock.calls[0]?.[0] as number;
    const secondDelay = fixture.sleep.mock.calls[1]?.[0] as number;
    expect(firstDelay).toBeGreaterThan(0);
    expect(secondDelay).toBe(firstDelay * 2);
    expect(body).toHaveBeenCalledTimes(3);
    expect(new Set(requestBodies).size).toBe(3);
    expect(requestContents).toEqual(["request-payload", "request-payload", "request-payload"]);
  });

  test("stops after three retryable HTTP responses", async () => {
    const fixture = createFixture([
      googleError(503, ["backendError"]),
      googleError(503, ["backendError"]),
      googleError(503, ["backendError"]),
      jsonResponse({ id: "video-1", title: "must not be reached" }),
    ]);

    await expect(
      fixture.client.request({
        channel: "deepfocus365",
        schema: responseSchema,
        url: "https://youtube.googleapis.com/youtube/v3/videos",
      }),
    ).rejects.toThrow();
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
    expect(fixture.sleep).toHaveBeenCalledTimes(2);
  });

  test("fails a non-quota forbidden response immediately", async () => {
    const fixture = createFixture([googleError(403, ["commentsDisabled"])]);

    const error = await fixture.client
      .request({
        channel: "deepfocus365",
        schema: responseSchema,
        url: "https://youtube.googleapis.com/youtube/v3/commentThreads",
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("403");
    expect((error as Error).message).toContain("commentsDisabled");
    expect(fixture.fetch).toHaveBeenCalledOnce();
    expect(fixture.sleep).not.toHaveBeenCalled();
  });

  test("uses the first Google error reason for both retry and the terminal error", async () => {
    const fixture = createFixture([
      googleError(403, ["quotaExceeded", "commentsDisabled"]),
      googleError(403, ["commentsDisabled", "quotaExceeded"]),
    ]);

    const error = await fixture.client
      .request({
        channel: "deepfocus365",
        schema: responseSchema,
        url: "https://youtube.googleapis.com/youtube/v3/commentThreads",
      })
      .catch((reason: unknown) => reason);

    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    expect(fixture.sleep).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("commentsDisabled");
    expect((error as Error).message).not.toContain("quotaExceeded");
  });

  test("does not expose the access token when the HTTP boundary fails", async () => {
    const auth = {
      getAccessToken: vi.fn().mockResolvedValue(accessToken),
      refreshAccessToken: vi.fn(),
    };
    const client = createYouTubeClient({
      auth,
      fetch: vi.fn().mockRejectedValue(new Error(`network error for Bearer ${accessToken}`)),
      random: () => 0,
      sleep: vi.fn(),
    });

    const error = await client
      .request({
        channel: "deepfocus365",
        schema: responseSchema,
        url: "https://youtube.googleapis.com/youtube/v3/videos",
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(accessToken);
  });
});
