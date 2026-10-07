// HTTP API 服务（node:http，无外部依赖）。
import * as http from "node:http";
import {
  AtmosphereError,
  ForwardResult,
  RULES_VERSION,
  describeConstants,
  describeLayers,
  forward,
  inverse,
  profile,
} from "./atmosphere";
import { AtmoDb } from "./db";

export const MAX_BATCH_ITEMS = 1000;

interface ApiOk {
  ok: true;
  data: unknown;
  recordId?: number;
}

interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}

function json(res: http.ServerResponse, status: number, body: ApiOk | ApiErr): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

function fail(res: http.ServerResponse, err: unknown): void {
  if (err instanceof AtmosphereError) {
    const status =
      err.code === "INVALID_INPUT" ||
      err.code === "HEIGHT_OUT_OF_RANGE" ||
      err.code === "PRESSURE_OUT_OF_RANGE"
        ? 400
        : err.code === "LIMIT_EXCEEDED"
          ? 413
          : 500;
    json(res, status, { ok: false, error: { code: err.code, message: err.message } });
  } else {
    json(res, 500, {
      ok: false,
      error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) },
    });
  }
}

function parseNum(value: string | null, name: string): number {
  if (value === null || value.trim() === "") {
    throw new AtmosphereError("INVALID_INPUT", `缺少参数 ${name}`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new AtmosphereError("INVALID_INPUT", `参数 ${name} 不是有限数值: ${value}`);
  }
  return n;
}

export function profileCsv(points: ForwardResult[]): string {
  const header = "h_m,layer,T_K,T_C,p_Pa,rho_kg_m3,formula";
  const lines = points.map(
    (r) => `${r.h},${r.layerIndex},${r.T},${r.T_C},${r.p},${r.rho},${r.formula}`,
  );
  return [header, ...lines].join("\r\n") + "\r\n";
}

export function createServer(db: AtmoDb): http.Server {
  return http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = url.pathname;
      if (req.method === "GET" && route === "/api/health") {
        json(res, 200, { ok: true, data: { status: "up", rulesVersion: RULES_VERSION } });
        return;
      }
      if (req.method === "GET" && route === "/api/constants") {
        json(res, 200, { ok: true, data: describeConstants() });
        return;
      }
      if (req.method === "GET" && route === "/api/layers") {
        json(res, 200, { ok: true, data: describeLayers() });
        return;
      }
      if (req.method === "GET" && route === "/api/atmosphere") {
        const h = parseNum(url.searchParams.get("h"), "h");
        const result = forward(h);
        const rec = db.record("forward", { h }, "m(geopotential)", RULES_VERSION, result, {
          checks: "T>0, finite, layer recursion from sea level",
        });
        json(res, 200, { ok: true, data: result, recordId: rec.id });
        return;
      }
      if (req.method === "GET" && route === "/api/inverse") {
        const p = parseNum(url.searchParams.get("p"), "p");
        const result = inverse(p);
        const rec = db.record("inverse", { p }, "Pa", RULES_VERSION, result, result.forwardCheck);
        json(res, 200, { ok: true, data: result, recordId: rec.id });
        return;
      }
      if (req.method === "GET" && (route === "/api/profile" || route === "/api/export")) {
        const from = parseNum(url.searchParams.get("from") ?? "0", "from");
        const to = parseNum(url.searchParams.get("to"), "to");
        const step = parseNum(url.searchParams.get("step"), "step");
        const result = profile(from, to, step);
        const rec = db.record(
          "profile",
          { from, to, step },
          "m(geopotential)",
          RULES_VERSION,
          result,
          { pointCount: result.pointCount, lastShortSegment: result.lastShortSegment },
        );
        const format =
          url.searchParams.get("format") ?? (route === "/api/export" ? "csv" : "json");
        if (format === "csv") {
          res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
          res.end(profileCsv(result.points));
        } else {
          json(res, 200, { ok: true, data: result, recordId: rec.id });
        }
        return;
      }
      if (req.method === "POST" && route === "/api/batch") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1000000) req.destroy();
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body || "{}") as {
              heights?: unknown[];
              pressures?: unknown[];
            };
            const heights = Array.isArray(parsed.heights) ? parsed.heights : [];
            const pressures = Array.isArray(parsed.pressures) ? parsed.pressures : [];
            if (heights.length + pressures.length === 0) {
              throw new AtmosphereError("INVALID_INPUT", "批量请求须包含 heights 或 pressures 数组");
            }
            if (heights.length + pressures.length > MAX_BATCH_ITEMS) {
              throw new AtmosphereError(
                "LIMIT_EXCEEDED",
                `批量规模 ${heights.length + pressures.length} 超过上限 ${MAX_BATCH_ITEMS}`,
              );
            }
            const items: unknown[] = [];
            for (const h of heights) {
              try {
                const result = forward(h as number);
                db.record("forward", { h }, "m(geopotential)", RULES_VERSION, result, {});
                items.push({ input: h, ok: true, data: result });
              } catch (e) {
                items.push({
                  input: h,
                  ok: false,
                  error:
                    e instanceof AtmosphereError
                      ? { code: e.code, message: e.message }
                      : { code: "INTERNAL", message: String(e) },
                });
              }
            }
            for (const p of pressures) {
              try {
                const result = inverse(p as number);
                db.record("inverse", { p }, "Pa", RULES_VERSION, result, result.forwardCheck);
                items.push({ input: p, ok: true, data: result });
              } catch (e) {
                items.push({
                  input: p,
                  ok: false,
                  error:
                    e instanceof AtmosphereError
                      ? { code: e.code, message: e.message }
                      : { code: "INTERNAL", message: String(e) },
                });
              }
            }
            json(res, 200, { ok: true, data: { items } });
          } catch (e) {
            fail(res, e);
          }
        });
        return;
      }
      if (req.method === "GET" && route === "/api/history") {
        const limit = Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 500);
        json(res, 200, { ok: true, data: db.history(limit) });
        return;
      }
      json(res, 404, {
        ok: false,
        error: { code: "NOT_FOUND", message: `未知路由 ${req.method} ${route}` },
      });
    } catch (err) {
      fail(res, err);
    }
  });
}

export function startServer(
  db: AtmoDb,
  port = 0,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(db);
    server.on("error", reject);
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, port: actual });
    });
  });
}
