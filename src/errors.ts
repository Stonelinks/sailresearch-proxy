export function openAIError(
  status: number,
  message: string,
  type = "server_error",
  param: string | null = null,
  code: string | null = null,
) {
  return Response.json({ error: { message, type, param, code } }, { status });
}

export function mapSailError(sailStatus: number, sailBody: any): Response {
  if (sailBody?.error?.message) {
    const status = sailStatus >= 500 ? 502 : sailStatus;
    return Response.json(sailBody, { status });
  }

  return openAIError(
    sailStatus >= 500 ? 502 : sailStatus,
    sailBody?.message || `Sail API error: ${sailStatus}`,
    sailBody?.type || "upstream_error",
  );
}
