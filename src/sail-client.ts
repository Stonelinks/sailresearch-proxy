import { config } from "./config.ts";

async function request(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${config.sail.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.sail.apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const data = await res.json();
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
};
