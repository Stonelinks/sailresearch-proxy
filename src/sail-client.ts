import { config } from "./config.ts";
import { log } from "./logger.ts";

async function request(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; data: any }> {
  const method = init.method ?? "GET";
  const bodyBytes =
    typeof init.body === "string" ? init.body.length : init.body ? -1 : 0;
  log.debug(`[sail] → ${method} ${path} bodyBytes=${bodyBytes}`);
  const start = Date.now();
  const res = await fetch(`${config.sail.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.sail.apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const data: any = await res.json();
  const ms = Date.now() - start;
  const respBytes = JSON.stringify(data).length;
  log.debug(
    `[sail] ← ${method} ${path} status=${res.status} ms=${ms} bodyBytes=${respBytes}`,
  );
  if (res.status < 200 || res.status >= 300) {
    log.warn(
      `[sail] non-2xx ${method} ${path} status=${res.status} error=${data?.error?.message ?? "<none>"}`,
    );
  }
  return { status: res.status, data };
}

export const sail = {
  chatCompletions(body: any) {
    return request("/chat/completions", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  createResponse(body: any) {
    return request("/responses", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  getResponse(responseId: string) {
    return request(`/responses/${responseId}`);
  },

  listModels() {
    return request("/models");
  },

  createMessage(body: any) {
    return request("/messages", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
};
