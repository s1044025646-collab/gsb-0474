// CLI 入口：node dist/cli.js <command> [options]
import {
  AtmosphereError,
  describeConstants,
  describeLayers,
  forward,
  inverse,
  profile,
} from "./atmosphere";
import { AtmoDb } from "./db";
import { profileCsv, startServer } from "./server";

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function num(value: string | undefined, name: string): number {
  if (value === undefined) throw new AtmosphereError("INVALID_INPUT", `缺少参数 --${name}`);
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new AtmosphereError("INVALID_INPUT", `参数 --${name} 不是有限数值: ${value}`);
  }
  return n;
}

const USAGE = [
  "分层标准大气（0-32000 m 位势高度） CLI",
  "用法:",
  "  node dist/cli.js h <位势高度m>            正向计算温度/气压/密度",
  "  node dist/cli.js p <气压Pa>               由气压反算位势高度（含正向复核残差）",
  "  node dist/cli.js profile --from A --to B --step S [--csv]",
  "  node dist/cli.js layers                   层界与层底状态",
  "  node dist/cli.js constants                常数与公式参数",
  "  node dist/cli.js history [--limit N]      查询历史（SQLite）",
  "  node dist/cli.js serve [--port N]         启动 HTTP API（默认端口 0 = 自动选空闲端口）",
  "  node dist/cli.js demo                     演示关键高度与反算",
  "",
].join("\n");

export async function run(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const db = new AtmoDb();
  try {
    switch (cmd) {
      case "h": {
        const h = num(rest[0], "h");
        const result = forward(h);
        const rec = db.record("forward", { h }, "m(geopotential)", result.rulesVersion, result, {});
        console.log(JSON.stringify({ recordId: rec.id, ...result }, null, 2));
        break;
      }
      case "p": {
        const p = num(rest[0], "p");
        const result = inverse(p);
        const rec = db.record("inverse", { p }, "Pa", result.rulesVersion, result, result.forwardCheck);
        console.log(JSON.stringify({ recordId: rec.id, ...result }, null, 2));
        break;
      }
      case "profile": {
        const from = num(getFlag(rest, "from") ?? "0", "from");
        const to = num(getFlag(rest, "to"), "to");
        const step = num(getFlag(rest, "step"), "step");
        const result = profile(from, to, step);
        db.record("profile", { from, to, step }, "m(geopotential)", result.rulesVersion, result, {
          pointCount: result.pointCount,
          lastShortSegment: result.lastShortSegment,
        });
        if (rest.includes("--csv")) {
          process.stdout.write(profileCsv(result.points));
          if (result.lastShortSegment !== null) {
            console.error(`提示: 步长不整除区间，最后短段 ${result.lastShortSegment} m`);
          }
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
        break;
      }
      case "layers":
        console.log(JSON.stringify(describeLayers(), null, 2));
        break;
      case "constants":
        console.log(JSON.stringify(describeConstants(), null, 2));
        break;
      case "history": {
        const limit = Number(getFlag(rest, "limit") ?? "20");
        console.log(JSON.stringify(db.history(limit), null, 2));
        break;
      }
      case "serve": {
        const port = Number(getFlag(rest, "port") ?? "0");
        const started = await startServer(db, port);
        console.log(`API 已启动: http://127.0.0.1:${started.port}/api/health (数据库: ${db.filePath})`);
        return;
      }
      case "demo": {
        console.log("== 演示：关键高度 ==");
        for (const h of [0, 11000, 20000, 32000]) {
          const r = forward(h);
          db.record("forward", { h }, "m(geopotential)", r.rulesVersion, r, {});
          console.log(
            `h=${h} m  层${r.layerIndex}  T=${r.T.toFixed(2)} K (${r.T_C.toFixed(2)} C)  ` +
              `p=${r.p.toFixed(3)} Pa  rho=${r.rho.toFixed(5)} kg/m^3  [${r.formula}]`,
          );
        }
        console.log("== 演示：气压反算 ==");
        for (const p of [101325, 22632.1, 5474.89, 868.019]) {
          try {
            const r = inverse(p);
            db.record("inverse", { p }, "Pa", r.rulesVersion, r, r.forwardCheck);
            console.log(
              `p=${p} Pa -> h=${r.h.toFixed(3)} m  残差=${r.forwardCheck.pressureResidual.toExponential(3)} Pa`,
            );
          } catch (e) {
            console.log(`p=${p} Pa -> ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        break;
      }
      default:
        process.stdout.write(USAGE);
        if (cmd) process.exitCode = 2;
    }
  } finally {
    if (argv[0] !== "serve") db.close();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((err) => {
    if (err instanceof AtmosphereError) {
      console.error(`错误 [${err.code}] ${err.message}`);
      process.exitCode = 1;
    } else {
      console.error(err);
      process.exitCode = 1;
    }
  });
}
