import {
  AtmosphereError,
  ForwardResult,
  InverseResult,
  LAYER_BASES,
  MAX_BATCH,
  ProfileResult,
  forward,
  inverse,
  profile,
  G,
  R,
  T0,
  P0,
  H_MIN,
  H_MAX,
  LAYERS,
  RULES_VERSION,
} from "./atmosphere";
import { Store } from "./db";

function forwardReport(r: ForwardResult): string {
  return [
    `规则版本 ${r.rulesVersion}；位势高度 h=${r.h} m，第 ${r.layerIndex} 层`,
    `层底 hb=${r.base.hb} m, Tb=${r.base.Tb} K, pb=${r.base.pb} Pa, L=${r.base.lapse} K/m`,
    `Δh=${r.deltaH} m，T=Tb+L*Δh=${r.T} K（${r.T_C} °C），温度比 T/Tb=${r.theta}`,
    r.exponent !== null ? `指数 -g/(R*L)=${r.exponent}` : "等温层，使用指数公式",
    `公式: ${r.formula}`,
    `p=${r.p} Pa，rho=p/(R*T)=${r.rho} kg/m^3`,
  ].join("\n");
}

function inverseReport(r: InverseResult): string {
  return [
    `规则版本 ${r.rulesVersion}；压力 p=${r.p} Pa，第 ${r.layerIndex} 层`,
    `层底 hb=${r.base.hb} m, Tb=${r.base.Tb} K, pb=${r.base.pb} Pa, L=${r.base.lapse} K/m`,
    `公式: ${r.formula}`,
    `反算 h=${r.h} m，T=${r.T} K`,
    `核验: forward(h).p - p = ${r.residualP} Pa（相对 ${r.residualPRel}），高度在范围内: ${r.hInRange}`,
  ].join("\n");
}

function profileReport(p: ProfileResult): string {
  return [
    `规则版本 ${p.rulesVersion}；剖面 [${p.from}, ${p.to}] m，步长 ${p.step} m，共 ${p.count} 点`,
    p.lastShortSegment
      ? "步长不整除区间，最后为短段（端点已包含，公式不变）"
      : "步长整除区间，端点已包含",
  ].join("\n");
}

export class Service {
  constructor(private store: Store) {}

  height(h: number) {
    try {
      const result = forward(h);
      const { record, deduplicated } = this.store.record("height", { h }, "m", {
        ok: true,
        result,
        report: forwardReport(result),
      });
      return { ok: true as const, result, recordId: record.id, deduplicated, report: record.report };
    } catch (e) {
      return this.fail("height", { h }, "m", e);
    }
  }

  pressure(p: number) {
    try {
      const result = inverse(p);
      const { record, deduplicated } = this.store.record("inverse", { p }, "Pa", {
        ok: true,
        result,
        report: inverseReport(result),
      });
      return { ok: true as const, result, recordId: record.id, deduplicated, report: record.report };
    } catch (e) {
      return this.fail("inverse", { p }, "Pa", e);
    }
  }

  profile(from: number, to: number, step: number) {
    try {
      const result = profile(from, to, step);
      const { record, deduplicated } = this.store.record(
        "profile",
        { from, to, step },
        "m",
        { ok: true, result, report: profileReport(result) },
      );
      return { ok: true as const, result, recordId: record.id, deduplicated, report: record.report };
    } catch (e) {
      return this.fail("profile", { from, to, step }, "m", e);
    }
  }

  /** 批量：逐项标记错误，正常结果不丢。 */
  batch(heights: number[]) {
    if (!Array.isArray(heights) || heights.length === 0) {
      throw new AtmosphereError("E_EMPTY_BATCH", "批量请求为空");
    }
    if (heights.length > MAX_BATCH) {
      throw new AtmosphereError("E_BATCH_TOO_LARGE", `批量规模超过上限 ${MAX_BATCH}`);
    }
    const items = heights.map((h, i) => {
      try {
        return { index: i, h, ok: true as const, result: forward(h) };
      } catch (e) {
        const err =
          e instanceof AtmosphereError
            ? e
            : new AtmosphereError("E_INTERNAL", String(e));
        return {
          index: i,
          h,
          ok: false as const,
          error: { code: err.code, message: err.message },
        };
      }
    });
    const okCount = items.filter((it) => it.ok).length;
    const report = `批量 ${items.length} 项：成功 ${okCount}，失败 ${items.length - okCount}`;
    const { record, deduplicated } = this.store.record("batch", { heights }, "m", {
      ok: true,
      result: items,
      report,
    });
    return { items, recordId: record.id, deduplicated, report };
  }

  layers() {
    return {
      rulesVersion: RULES_VERSION,
      layers: LAYER_BASES.map((b, i) => ({
        index: i,
        hb: b.hb,
        hTop: i + 1 < LAYER_BASES.length ? LAYER_BASES[i + 1].hb : H_MAX,
        lapse: b.lapse,
        Tb: b.Tb,
        pb: b.pb,
      })),
    };
  }

  constants() {
    return {
      rulesVersion: RULES_VERSION,
      g: G,
      R,
      T0,
      P0,
      hMin: H_MIN,
      hMax: H_MAX,
      layers: LAYERS,
      note: "输入为位势高度；常数与层表随规则版本冻结，不受环境变量影响。",
    };
  }

  private fail(type: string, input: unknown, unit: string, e: unknown) {
    const err =
      e instanceof AtmosphereError ? e : new AtmosphereError("E_INTERNAL", String(e));
    const report = `错误 ${err.code}: ${err.message}`;
    const { record, deduplicated } = this.store.record(type, input, unit, {
      ok: false,
      code: err.code,
      message: err.message,
      report,
    });
    return {
      ok: false as const,
      error: { code: err.code, message: err.message },
      recordId: record.id,
      deduplicated,
      report,
    };
  }
}
