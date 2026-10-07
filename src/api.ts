import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { Service } from "./service";
import { Store, defaultDataDir } from "./db";
import { AtmosphereError, ForwardResult } from "./atmosphere";

function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8") {
  const payload =
    contentType.startsWith("application/json") ? JSON.stringify(body, null, 2) : String(body);
  res.writeHead(status, { "Content-Type": contentType });
  res.end(payload);
}

function parseNum(value: string | null, name: string): number {
  if (value === null || value.trim() === "") {
    throw new AtmosphereError("E_MISSING_PARAM", `缺少参数 ${name}`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new AtmosphereError("E_NOT_A_NUMBER", `参数 ${name}=${value} 不是有限数字`);
  }
  return n;
}

function profileCsv(points: ForwardResult[]): string {
  const header = "h_m,layer,T_K,T_C,p_Pa,rho_kg_m3,hb_m,Tb_K,pb_Pa,lapse_K_m";
  const rows = points.map((r) =>
    [r.h, r.layerIndex, r.T, r.T_C, r.p, r.rho, r.base.hb, r.base.Tb, r.base.pb, r.base.lapse].join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}

async function readBody(req: IncomingMessage): Promise<string> {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data;
}

export function startServer(service: Service, store: Store, port: number) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = url.searchParams;
    try {
      if (req.method === "GET" && url.pathname === "/api/health") {
        return send(res, 200, { ok: true, rulesVersion: service.constants().rulesVersion });
      }
      if (req.method === "GET" && url.pathname === "/api/constants") {
        return send(res, 200, service.constants());
      }
      if (req.method === "GET" && url.pathname === "/api/layers") {
        return send(res, 200, service.layers());
      }
      if (req.method === "GET" && url.pathname === "/api/atmosphere") {
        const h = parseNum(q.get("h"), "h");
        const r = service.height(h);
        return send(res, r.ok ? 200 : 400, r);
      }
      if (req.method === "GET" && url.pathname === "/api/inverse") {
        const p = parseNum(q.get("p"), "p");
        const r = service.pressure(p);
        return send(res, r.ok ? 200 : 400, r);
      }
      if (req.method === "GET" && url.pathname === "/api/profile") {
        const from = parseNum(q.get("from"), "from");
        const to = parseNum(q.get("to"), "to");
        const step = parseNum(q.get("step"), "step");
        const r = service.profile(from, to, step);
        if (!r.ok) return send(res, 400, r);
        const format = q.get("format") ?? "json";
        if (format === "csv") {
          return send(res, 200, profileCsv(r.result.points), "text/csv; charset=utf-8");
        }
        return send(res, 200, r);
      }
      if (req.method === "POST" && url.pathname === "/api/batch") {
        const body = JSON.parse(await readBody(req));
        const r = service.batch(body.heights);
        return send(res, 200, r);
      }
      if (req.method === "GET" && url.pathname === "/api/records") {
        const limit = q.get("limit") ? parseNum(q.get("limit"), "limit") : 100;
        const records = store.list(Math.min(limit, 1000));
        const format = q.get("format") ?? "json";
        if (format === "csv") {
          const header = "id,type,unit,rules_version,ok,error_code,created_at,request_hash";
          const rows = records.map((r) =>
            [r.id, r.type, r.unit, r.rulesVersion, r.ok, r.errorCode ?? "", r.createdAt, r.requestHash].join(","),
          );
          return send(res, 200, [header, ...rows].join("\n") + "\n", "text/csv; charset=utf-8");
        }
        return send(res, 200, { records });
      }
      const m = /^\/api\/records\/(\d+)$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const record = store.get(Number(m[1]));
        if (!record) {
          return send(res, 404, { error: { code: "E_NOT_FOUND", message: "记录不存在" } });
        }
        return send(res, 200, {
          ...record,
          input: JSON.parse(record.inputJson),
          result: record.resultJson ? JSON.parse(record.resultJson) : null,
        });
      }
      return send(res, 404, { error: { code: "E_NOT_FOUND", message: "未知路由" } });
    } catch (e) {
      const err =
        e instanceof AtmosphereError ? e : new AtmosphereError("E_BAD_REQUEST", String(e));
      return send(res, 400, { error: { code: err.code, message: err.message } });
    }
  });
  return new Promise<{ server: typeof server; port: number }>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

export async function serve(port: number, dataDir = defaultDataDir()) {
  const store = new Store(dataDir);
  const service = new Service(store);
  const { port: actual } = await startServer(service, store, port);
  console.log(`ISA 分层大气服务已启动: http://127.0.0.1:${actual}  (数据目录: ${dataDir})`);
  return actual;
}
