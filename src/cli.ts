import { Service } from "./service";
import { Store, defaultDataDir } from "./db";
import { serve } from "./api";
import { ForwardResult } from "./atmosphere";

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function num(s: string | undefined, name: string): number {
  if (s === undefined) throw new Error(`缺少参数 ${name}`);
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`参数 ${name} 不是有限数字: ${s}`);
  return n;
}

function printForward(r: ForwardResult): void {
  console.log(`h=${r.h} m  第${r.layerIndex}层  T=${r.T} K (${r.T_C} °C)  p=${r.p} Pa  rho=${r.rho} kg/m^3`);
  console.log(`  层底 hb=${r.base.hb} Tb=${r.base.Tb} pb=${r.base.pb} L=${r.base.lapse}  公式: ${r.formula}`);
}

const USAGE = `用法:
  node dist/cli.js serve [--port N]        启动 API 服务（默认自动选空闲端口）
  node dist/cli.js height <h>              位势高度 -> T/p/rho
  node dist/cli.js inverse <p>             压力 -> 位势高度（含残差核验）
  node dist/cli.js profile <from> <to> <step> [--format json|csv]
  node dist/cli.js batch <h1,h2,...>       批量正算（逐项标记错误）
  node dist/cli.js layers                  层界与层底状态
  node dist/cli.js constants               公式参数与冻结常数
  node dist/cli.js records [--limit N] [--format json|csv]
  node dist/cli.js export --format json|csv
  node dist/cli.js demo                    演示关键点数值
通用: --data-dir <目录>（默认 ./data）`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  const dataDir = argValue(args, "--data-dir") ?? defaultDataDir();

  if (cmd === "serve") {
    const portFlag = argValue(args, "--port");
    const port = portFlag !== undefined ? num(portFlag, "port") : 0; // 0 = 空闲端口
    await serve(port, dataDir);
    return;
  }

  const store = new Store(dataDir);
  const service = new Service(store);
  try {
    switch (cmd) {
      case "height": {
        const r = service.height(num(args[1], "h"));
        if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
        printForward(r.result);
        console.log(`记录 #${r.recordId}${r.deduplicated ? "（幂等去重）" : ""}`);
        break;
      }
      case "inverse": {
        const r = service.pressure(num(args[1], "p"));
        if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
        console.log(`p=${r.result.p} Pa -> h=${r.result.h} m  T=${r.result.T} K  第${r.result.layerIndex}层`);
        console.log(`  残差 forward(h).p-p=${r.result.residualP} Pa  范围内=${r.result.hInRange}`);
        console.log(`记录 #${r.recordId}${r.deduplicated ? "（幂等去重）" : ""}`);
        break;
      }
      case "profile": {
        const r = service.profile(num(args[1], "from"), num(args[2], "to"), num(args[3], "step"));
        if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
        const format = argValue(args, "--format") ?? "json";
        if (format === "csv") {
          console.log("h_m,layer,T_K,p_Pa,rho_kg_m3");
          for (const p of r.result.points) {
            console.log(`${p.h},${p.layerIndex},${p.T},${p.p},${p.rho}`);
          }
        } else {
          console.log(JSON.stringify(r.result, null, 2));
        }
        console.error(`共 ${r.result.count} 点${r.result.lastShortSegment ? "（最后短段）" : ""}，记录 #${r.recordId}`);
        break;
      }
      case "batch": {
        const heights = String(args[1] ?? "").split(",").filter(Boolean).map(Number);
        const r = service.batch(heights);
        for (const it of r.items) {
          if (it.ok) console.log(`[${it.index}] h=${it.h} -> p=${it.result.p} Pa, T=${it.result.T} K`);
          else console.log(`[${it.index}] h=${it.h} -> 错误 ${it.error.code}: ${it.error.message}`);
        }
        console.log(r.report);
        break;
      }
      case "layers":
        console.log(JSON.stringify(service.layers(), null, 2));
        break;
      case "constants":
        console.log(JSON.stringify(service.constants(), null, 2));
        break;
      case "records":
      case "export": {
        const limit = num(argValue(args, "--limit") ?? "100", "limit");
        const format = argValue(args, "--format") ?? "json";
        const records = store.list(Math.min(limit, 1000));
        if (format === "csv") {
          console.log("id,type,unit,rules_version,ok,error_code,created_at,request_hash");
          for (const r of records) {
            console.log([r.id, r.type, r.unit, r.rulesVersion, r.ok, r.errorCode ?? "", r.createdAt, r.requestHash].join(","));
          }
        } else {
          console.log(JSON.stringify(records, null, 2));
        }
        break;
      }
      case "demo": {
        for (const h of [0, 11000, 20000, 32000]) {
          const r = service.height(h);
          if (r.ok) printForward(r.result);
        }
        const inv = service.pressure(101325);
        if (inv.ok) console.log(`inverse(101325 Pa) -> h=${inv.result.h} m, 残差=${inv.result.residualP} Pa`);
        break;
      }
      default:
        console.error(`未知命令: ${cmd}\n${USAGE}`);
        process.exitCode = 2;
    }
  } finally {
    store.close();
  }
}

main().catch((e) => {
  console.error(`错误: ${e.message}`);
  process.exitCode = 1;
});
