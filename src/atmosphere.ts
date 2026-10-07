/**
 * 分层标准大气核心模型（教学用，规则版本冻结）。
 * 输入为位势高度 h（米），不做几何海拔换算、不读取天气。
 */

export const RULES_VERSION = "ISA-LAYERED-0474-v1";

export const G = 9.80665; // m/s^2
export const R = 287.05287; // J/(kg*K)
export const T0 = 288.15; // K
export const P0 = 101325; // Pa

export interface LayerDef {
  index: number;
  hb: number; // 层底位势高度 m
  lapse: number; // 温度梯度 K/m
}

/** 冻结层表：层界 0/11000/20000/32000，梯度 -0.0065/0/+0.001 */
export const LAYERS: LayerDef[] = [
  { index: 0, hb: 0, lapse: -0.0065 },
  { index: 1, hb: 11000, lapse: 0 },
  { index: 2, hb: 20000, lapse: 0.001 },
];
export const H_MIN = 0;
export const H_MAX = 32000;

export interface LayerBase {
  index: number;
  hb: number;
  Tb: number;
  pb: number;
  lapse: number;
}

/** 从首层逐层递推层底温压（不舍入，供正算/反算共用）。 */
export function computeLayerBases(): LayerBase[] {
  const bases: LayerBase[] = [];
  let Tb = T0;
  let pb = P0;
  for (let i = 0; i < LAYERS.length; i++) {
    const layer = LAYERS[i];
    bases.push({ index: i, hb: layer.hb, Tb, pb, lapse: layer.lapse });
    const nextHb = i + 1 < LAYERS.length ? LAYERS[i + 1].hb : H_MAX;
    const dh = nextHb - layer.hb;
    const T = Tb + layer.lapse * dh;
    const p =
      layer.lapse !== 0
        ? pb * Math.pow(T / Tb, -G / (R * layer.lapse))
        : pb * Math.exp((-G * dh) / (R * Tb));
    Tb = T;
    pb = p;
  }
  return bases;
}

export const LAYER_BASES: LayerBase[] = computeLayerBases();

export class AtmosphereError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AtmosphereError";
  }
}

function assertFinite(name: string, v: number): void {
  if (typeof v !== "number" || Number.isNaN(v)) {
    throw new AtmosphereError("E_NOT_A_NUMBER", `${name} 不是有效数字`);
  }
  if (!Number.isFinite(v)) {
    throw new AtmosphereError("E_NOT_FINITE", `${name} 不是有限值`);
  }
}

/** 归层约定：恰好位于内部层界归更高一层；最顶端归最后一层。 */
export function layerIndexForHeight(h: number): number {
  assertFinite("h", h);
  if (h < H_MIN || h > H_MAX) {
    throw new AtmosphereError(
      "E_HEIGHT_OUT_OF_RANGE",
      `位势高度 h=${h} 超出模型范围 [${H_MIN}, ${H_MAX}] m`,
    );
  }
  if (h === H_MAX) return LAYERS.length - 1;
  for (let i = 0; i < LAYERS.length; i++) {
    const top = i + 1 < LAYERS.length ? LAYERS[i + 1].hb : H_MAX;
    if (h >= LAYERS[i].hb && h < top) return i;
  }
  return LAYERS.length - 1;
}

export interface ForwardResult {
  rulesVersion: string;
  h: number;
  layerIndex: number;
  base: { hb: number; Tb: number; pb: number; lapse: number };
  deltaH: number;
  T: number;
  T_C: number;
  p: number;
  rho: number;
  theta: number; // T/Tb
  exponent: number | null; // 非等温层指数 -g/(R*L)，等温层为 null
  formula: string;
}

export function forward(h: number): ForwardResult {
  const idx = layerIndexForHeight(h);
  const base = LAYER_BASES[idx];
  const dh = h - base.hb;
  const T = base.Tb + base.lapse * dh;
  if (!(T > 0)) {
    throw new AtmosphereError("E_NONPOSITIVE_TEMPERATURE", `温度非正: T=${T} K`);
  }
  let p: number;
  let exponent: number | null;
  let formula: string;
  const theta = T / base.Tb;
  if (base.lapse !== 0) {
    exponent = -G / (R * base.lapse);
    p = base.pb * Math.pow(theta, exponent);
    formula = "p = pb * (T/Tb)^(-g/(R*L))";
  } else {
    exponent = null;
    p = base.pb * Math.exp((-G * dh) / (R * base.Tb));
    formula = "p = pb * exp(-g*dh/(R*Tb))";
  }
  const rho = p / (R * T);
  if (!(p > 0) || !Number.isFinite(p) || !Number.isFinite(rho)) {
    throw new AtmosphereError("E_NONFINITE_RESULT", "计算结果非有限正值");
  }
  return {
    rulesVersion: RULES_VERSION,
    h,
    layerIndex: idx,
    base: { hb: base.hb, Tb: base.Tb, pb: base.pb, lapse: base.lapse },
    deltaH: dh,
    T,
    T_C: T - 273.15,
    p,
    rho,
    theta,
    exponent,
    formula,
  };
}

export interface InverseResult {
  rulesVersion: string;
  p: number;
  layerIndex: number;
  base: { hb: number; Tb: number; pb: number; lapse: number };
  h: number;
  T: number;
  formula: string;
  residualP: number; // forward(h).p - p
  residualPRel: number;
  hInRange: boolean;
}

/** 反算：压力越小高度越高；内部边界与正算同约定（边界压力归更高一层）。 */
export function layerIndexForPressure(p: number): number {
  // 层界压力（各层顶/底处）：P0, p(11000), p(20000), p(32000)
  const bounds = LAYER_BASES.map((b) => b.pb).concat([forward(H_MAX).p]);
  for (let i = 0; i < LAYERS.length; i++) {
    const pTop = bounds[i + 1];
    const pBottom = bounds[i];
    const isLast = i === LAYERS.length - 1;
    // 边界压力归更高一层：p == pTop 且非最顶层 → 下一层
    if (isLast ? p >= pTop && p <= pBottom : p > pTop && p <= pBottom) {
      return i;
    }
  }
  throw new AtmosphereError("E_PRESSURE_OUT_OF_RANGE", `压力 p=${p} 不在模型范围内`);
}

export function inverse(p: number): InverseResult {
  assertFinite("p", p);
  if (!(p > 0)) {
    throw new AtmosphereError("E_PRESSURE_NOT_POSITIVE", `压力必须为正: p=${p}`);
  }
  const pMin = forward(H_MAX).p;
  const pMax = P0;
  if (p < pMin || p > pMax) {
    throw new AtmosphereError(
      "E_PRESSURE_OUT_OF_RANGE",
      `压力 p=${p} Pa 超出模型范围 [${pMin}, ${pMax}] Pa`,
    );
  }
  const idx = layerIndexForPressure(p);
  const base = LAYER_BASES[idx];
  let h: number;
  let T: number;
  let formula: string;
  if (base.lapse !== 0) {
    // T = Tb * (p/pb)^(-R*L/g); dh = (T - Tb)/L
    T = base.Tb * Math.pow(p / base.pb, (-R * base.lapse) / G);
    h = base.hb + (T - base.Tb) / base.lapse;
    formula = "T = Tb*(p/pb)^(-R*L/g); h = hb + (T-Tb)/L";
  } else {
    T = base.Tb;
    h = base.hb + (-R * base.Tb * Math.log(p / base.pb)) / G;
    formula = "h = hb - R*Tb/g * ln(p/pb)";
  }
  const check = forward(h);
  const residualP = check.p - p;
  return {
    rulesVersion: RULES_VERSION,
    p,
    layerIndex: idx,
    base: { hb: base.hb, Tb: base.Tb, pb: base.pb, lapse: base.lapse },
    h,
    T,
    formula,
    residualP,
    residualPRel: residualP / p,
    hInRange: h >= H_MIN && h <= H_MAX,
  };
}

export interface ProfileResult {
  rulesVersion: string;
  from: number;
  to: number;
  step: number;
  count: number;
  lastShortSegment: boolean;
  points: ForwardResult[];
}

export const MAX_PROFILE_POINTS = 5000;
export const MAX_BATCH = 1000;

/** 剖面：必含起止端点；步长不整除时最后为短段。 */
export function profile(from: number, to: number, step: number): ProfileResult {
  assertFinite("from", from);
  assertFinite("to", to);
  assertFinite("step", step);
  if (!(step > 0)) throw new AtmosphereError("E_STEP_NOT_POSITIVE", "步长必须为正");
  if (to < from) throw new AtmosphereError("E_BAD_RANGE", "to 必须 >= from");
  layerIndexForHeight(from);
  layerIndexForHeight(to);
  const span = to - from;
  const fullSteps = Math.floor(span / step + 1e-12);
  const lastShortSegment = span - fullSteps * step > 1e-9;
  const count = fullSteps + 1 + (lastShortSegment ? 1 : 0);
  if (count > MAX_PROFILE_POINTS) {
    throw new AtmosphereError(
      "E_PROFILE_TOO_LARGE",
      `剖面采样点 ${count} 超过上限 ${MAX_PROFILE_POINTS}`,
    );
  }
  const points: ForwardResult[] = [];
  for (let i = 0; i <= fullSteps; i++) points.push(forward(from + i * step));
  if (lastShortSegment) points.push(forward(to));
  return {
    rulesVersion: RULES_VERSION,
    from,
    to,
    step,
    count,
    lastShortSegment,
    points,
  };
}
