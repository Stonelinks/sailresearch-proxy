import { sail } from "../sail-client.ts";
import { mapSailError } from "../errors.ts";

export async function handleModels(): Promise<Response> {
  const { status, data } = await sail.listModels();
  if (status !== 200) return mapSailError(status, data);
  return Response.json(data);
}
