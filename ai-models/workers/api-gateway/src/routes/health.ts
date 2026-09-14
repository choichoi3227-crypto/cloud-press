import { Hono } from "hono";
import { HonoBindings } from "../env";

const health = new Hono<HonoBindings>();

health.get("/", async (c) => {
  let inferenceStatus: unknown = null;
  try {
    const res = await fetch(`${c.env.INFERENCE_SERVER_URL}/v1/health`);
    inferenceStatus = await res.json();
  } catch {
    inferenceStatus = { status: "unreachable" };
  }

  return c.json({
    status: "ok",
    worker: "cloud-press-api-gateway",
    inference_server: inferenceStatus,
  });
});

export default health;
