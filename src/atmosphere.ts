/**
 * 分层标准大气核心模型（教学用，0 ~ 32000 m 位势高度）。
 *
 * 固定常数与层表随规则版本冻结，不读取任何环境变量或外部数据。
 * 输入高度一律为位势高度（geopotential height），不做几何海拔换算。
 */

export const RULES_VERSION = "ISA-0474-v1";

export const G = 9.80665; // m/s^2
export const R = 287.05287; // J/(kg*K)
export const T0 = 288.15; // K
export const P0 = 101325; // Pa

export const H_MIN = 0;
export const H_MAX = 32000;

export interface LayerDef {
  index: number;
  hb: number; // 层底位势高度 m
  lapse: number; // 温度梯度 K/m
}

/** 层界高度 0 / 11000 / 20000 / 32000 m，三层梯度 -0.0065 / 0 / +0.001 K/m */
export const LAYERS: readonly LayerDef[] = Object.freeze([
  Object.freeze({ index: 0, hb: 0, lapse: -0.0065 }),
  Object.freeze({ index: 1, hb: 11000, lapse: 0 }),
  Object.freeze({ index: 2, hb: 20000, lapse: 0.001 }),
]);

export interface LayerBaseState {
  index: number;
  hb: number;
  lapse: number;
  Tb: number; // 层底温度 K
  pb: number; // 层底压力 Pa
}

export class AtmosphereError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AtmosphereError";
  }
}

/** 由首层逐层递推得到的各层层底状态（模块加载时计算一次并冻结）。 */
function computeLayerBases(): LayerBaseState[] {
  const bases: LayerBaseState[] = [];
  let Tb = T0;
  let pb = P0;
  for (let i = 0; i < LAYERS.length; i++) {
    const layer = LAYERS[i];
    bases.push({ index: i, hb: layer.hb, lapse: layer.lapse, Tb, pb });
    const top = i + 1 < LAYERS.length ? LAYERS[i + 1].hb : H_MAX;
    const dh = top - layer.hb;
    const Tt = Tb + layer.lapse * dh;
    let pt: number;
    if (layer.lapse !== 0) {
      pt = pb * Math.pow(Tt / Tb, -G / (R * layer.lapse));
    } else {
      pt = pb * Math.exp((-G * dh) / (R * Tb));
    }
    if (!(Tt > 0) || !Number.isFinite(Tt) || !Number.isFinite(pt) || !(pt > 0)) {
      throw new AtmosphereError("MODEL_INVALID", `层 ${i} 顶端状态非法: T=${Tt}, p=${pt}`);
    }
    Tb = Tt;
    pb = pt;
  }
  return bases;
}

export const LAYER_BASES: readonly LayerBaseState[] = Object.freeze(computeLayerBases());

/** 模型顶端（32000 m）压力，用于反算范围校验。 */
export const P_TOP: number = LAYER_BASES[LAYERS.length - 1].lapse !== 0
  ? (() => {
      const b = LAYER_BASES[LAYERS.length - 1];
      const Tt = b.Tb + b.lapse * (H_MAX - b.hb);
      return b.pb * Math.pow(Tt / b.Tb, -G / (R * b.lapse));
    })()
  : (() => {
      const b = LAYER_BASES[LAYERS.length - 1];
      return b.pb * Math.exp((-G * (H_MAX - b.hb)) / (R * b.Tb));
    })();

export type FormulaKind = "nonzero-lapse" | "isothermal";

export interface ForwardResult {
  h: number; // 位势高度 m
  layerIndex: number;
  layerBase: { hb: number; Tb: number; pb: number; lapse: number };
  deltaH: number;
  T: number; // K
  T_C: number; // 仅显示用，不参与气压公式
  p: number; // Pa
  rho: number; // kg/m^3, p/(R*T)
  temperatureRatio: number; // T/Tb
  exponent: number; // 非零梯度: -g/(R*L)；等温: -g*Δh/(R*Tb)
  formula: FormulaKind;
  rulesVersion: string;
}

/** 归层约定：恰好位于内部层界时归更高一层；顶端 32000 m 归最后一层。 */
export function layerIndexForHeight(h: number): number {
  if (h === H_MAX) return LAYERS.length - 1;
  for (let i = LAYERS.length - 1; i >= 0; i--) {
    if (h >= LAYERS[i].hb) return i;
  }
  return 0;
}

function assertFiniteResults(T: number, p: number, rho: number): void {
  if (!(T > 0) || !Number.isFinite(T)) {
    throw new AtmosphereError("MODEL_INVALID", `温度非正或非法: T=${T}`);
  }
  if (!(p > 0) || !Number.isFinite(p)) {
    throw new AtmosphereError("MODEL_INVALID", `压力非正或非法（不允许以零压力掩盖下溢）: p=${p}`);
  }
  if (!(rho > 0) || !Number.isFinite(rho)) {
    throw new AtmosphereError("MODEL_INVALID", `密度非法: rho=${rho}`);
  }
}

/** 正向计算：位势高度 -> 温度 / 气压 / 密度。 */
export function forward(h: number): ForwardResult {
  if (typeof h !== "number" || !Number.isFinite(h)) {
    throw new AtmosphereError("INVALID_INPUT", `高度必须为有限数值，收到: ${String(h)}`);
  }
  if (h < H_MIN || h > H_MAX) {
    throw new AtmosphereError(
      "HEIGHT_OUT_OF_RANGE",
      `位势高度 ${h} m 超出模型范围 [${H_MIN}, ${H_MAX}] m，不向外套用末层公式`,
    );
  }
  const idx = layerIndexForHeight(h);
  const base = LAYER_BASES[idx];
  const deltaH = h - base.hb;
  const T = base.Tb + base.lapse * deltaH;
  let p: number;
  let exponent: number;
  let formula: FormulaKind;
  if (base.lapse !== 0) {
    exponent = -G / (R * base.lapse);
    p = base.pb * Math.pow(T / base.Tb, exponent);
    formula = "nonzero-lapse";
  } else {
    exponent = (-G * deltaH) / (R * base.Tb);
    p = base.pb * Math.exp(exponent);
    formula = "isothermal";
  }
  const rho = p / (R * T);
  assertFiniteResults(T, p, rho);
  return {
    h,
    layerIndex: idx,
    layerBase: { hb: base.hb, Tb: base.Tb, pb: base.pb, lapse: base.lapse },
    deltaH,
    T,
    T_C: T - 273.15,
    p,
    rho,
    temperatureRatio: T / base.Tb,
    exponent,
    formula,
    rulesVersion: RULES_VERSION,
  };
}

export interface InverseResult {
  p: number; // 输入压力 Pa
  h: number; // 反算位势高度 m
  layerIndex: number;
  layerBase: { hb: number; Tb: number; pb: number; lapse: number };
  T: number;
  rho: number;
  formula: FormulaKind;
  forwardCheck: {
    pRecomputed: number; // 反算高度再代入正向模型的压力
    pressureResidual: number; // pRecomputed - p
    relativeResidual: number;
    heightInRange: boolean;
  };
  rulesVersion: string;
}

/** 反算归层：压力越小高度越高；内部边界压力归更高一层（与正向一致）。 */
export function layerIndexForPressure(p: number): number {
  for (let i = 0; i < LAYERS.length; i++) {
    const pBase = LAYER_BASES[i].pb;
    const pTop =
      i + 1 < LAYERS.length ? LAYER_BASES[i + 1].pb : P_TOP;
    const isLast = i === LAYERS.length - 1;
    if (p <= pBase && (isLast ? p >= pTop : p > pTop)) return i;
  }
  // 恰等于某内部层界压力时归更高一层
  for (let i = 1; i < LAYERS.length; i++) {
    if (p === LAYER_BASES[i].pb) return i;
  }
  throw new AtmosphereError("PRESSURE_OUT_OF_RANGE", `压力 ${p} Pa 不在任何层范围内`);
}

/** 反算：模型范围内气压 -> 位势高度（解析公式，不用查表或迭代）。 */
export function inverse(p: number): InverseResult {
  if (typeof p !== "number" || !Number.isFinite(p)) {
    throw new AtmosphereError("INVALID_INPUT", `压力必须为有限数值，收到: ${String(p)}`);
  }
  if (!(p > 0)) {
    throw new AtmosphereError("INVALID_INPUT", `压力必须为正，收到: ${p}`);
  }
  if (p > P0 || p < P_TOP) {
    throw new AtmosphereError(
      "PRESSURE_OUT_OF_RANGE",
      `压力 ${p} Pa 超出模型范围 [${P_TOP}, ${P0}] Pa（对应位势高度 0 ~ ${H_MAX} m）`,
    );
  }
  const idx = layerIndexForPressure(p);
  const base = LAYER_BASES[idx];
  let h: number;
  let formula: FormulaKind;
  if (base.lapse !== 0) {
    const T = base.Tb * Math.pow(p / base.pb, (-R * base.lapse) / G);
    h = base.hb + (T - base.Tb) / base.lapse;
    formula = "nonzero-lapse";
  } else {
    h = base.hb + (-R * base.Tb * Math.log(p / base.pb)) / G;
    formula = "isothermal";
  }
  const fwd = forward(h);
  const residual = fwd.p - p;
  return {
    p,
    h,
    layerIndex: idx,
    layerBase: { hb: base.hb, Tb: base.Tb, pb: base.pb, lapse: base.lapse },
    T: fwd.T,
    rho: fwd.rho,
    formula,
    forwardCheck: {
      pRecomputed: fwd.p,
      pressureResidual: residual,
      relativeResidual: residual / p,
      heightInRange: h >= H_MIN && h <= H_MAX,
    },
    rulesVersion: RULES_VERSION,
  };
}

export const MAX_PROFILE_POINTS = 10001;

export interface ProfileResult {
  from: number;
  to: number;
  step: number;
  pointCount: number;
  /** 步长不整除区间时，最后一段的实际长度；整除时为 null */
  lastShortSegment: number | null;
  points: ForwardResult[];
  rulesVersion: string;
}

/** 剖面生成：必含起止端点；步长不整除时末尾补终点并说明短段。 */
export function profile(from: number, to: number, step: number): ProfileResult {
  for (const [name, v] of [["from", from], ["to", to], ["step", step]] as const) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new AtmosphereError("INVALID_INPUT", `${name} 必须为有限数值，收到: ${String(v)}`);
    }
  }
  if (from < H_MIN || to > H_MAX || from > to) {
    throw new AtmosphereError(
      "HEIGHT_OUT_OF_RANGE",
      `剖面区间 [${from}, ${to}] 非法，须满足 ${H_MIN} <= from <= to <= ${H_MAX}`,
    );
  }
  if (!(step > 0)) {
    throw new AtmosphereError("INVALID_INPUT", `步长必须为正，收到: ${step}`);
  }
  const span = to - from;
  const fullSteps = Math.floor(span / step + 1e-12);
  const remainder = span - fullSteps * step;
  const hasShort = remainder > 1e-9;
  const count = fullSteps + 1 + (hasShort ? 1 : 0);
  if (count > MAX_PROFILE_POINTS) {
    throw new AtmosphereError(
      "LIMIT_EXCEEDED",
      `剖面采样点 ${count} 超过上限 ${MAX_PROFILE_POINTS}，请增大步长`,
    );
  }
  const points: ForwardResult[] = [];
  for (let i = 0; i <= fullSteps; i++) {
    points.push(forward(from + i * step));
  }
  if (hasShort) {
    points.push(forward(to));
  }
  return {
    from,
    to,
    step,
    pointCount: points.length,
    lastShortSegment: hasShort ? remainder : null,
    points,
    rulesVersion: RULES_VERSION,
  };
}

/** 层界与公式参数说明（供 API/CLI 查询）。 */
export function describeLayers() {
  return LAYER_BASES.map((b, i) => ({
    index: i,
    hb: b.hb,
    hTop: i + 1 < LAYERS.length ? LAYERS[i + 1].hb : H_MAX,
    lapse: b.lapse,
    Tb: b.Tb,
    pb: b.pb,
    formula:
      b.lapse !== 0
        ? "p = pb * (T/Tb)^(-g/(R*L)), T = Tb + L*(h-hb)"
        : "p = pb * exp(-g*(h-hb)/(R*Tb)), T = Tb",
    inverseFormula:
      b.lapse !== 0
        ? "h = hb + (Tb*(p/pb)^(-R*L/g) - Tb)/L"
        : "h = hb - R*Tb*ln(p/pb)/g",
  }));
}

export function describeConstants() {
  return {
    rulesVersion: RULES_VERSION,
    g: G,
    R,
    T0,
    P0,
    H_MIN,
    H_MAX,
    P_TOP,
    note: "输入高度为位势高度；温度开尔文；rho = p/(R*T)；摄氏度仅用于显示。常数与层表随规则版本冻结。",
  };
}
