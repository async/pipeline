// A small Deno HTTP worker. `deno serve worker/main.ts` runs it; the
// pipeline's node-side tasks only validate config and route metadata, so the
// pipeline itself never needs the Deno binary.

export interface RouteResult {
  status: number;
  body: Record<string, unknown>;
}

export function route(pathname: string, startedAt: Date): RouteResult {
  if (pathname === "/health") {
    return {
      status: 200,
      body: { status: "ok", startedAt: startedAt.toISOString() }
    };
  }
  if (pathname === "/version") {
    return {
      status: 200,
      body: { worker: "example-deno-worker", version: "0.1.0" }
    };
  }
  return {
    status: 404,
    body: { error: `No route for ${pathname}` }
  };
}

const startedAt = new Date();

export default {
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    const result = route(pathname, startedAt);
    return Response.json(result.body, { status: result.status });
  }
};
