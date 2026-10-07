import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AtmosphereError,
  G,
  H_MAX,
  LAYER_BASES,
  P0,
  P_TOP,
  R,
  T0,
  forward,
  inverse,
  profile,
} from "../src/atmosphere";
import { AtmoDb } from "../src/db";

const EPS = 1e-9;

test("海平面精确返回 288.15 K 与 101325 Pa", () => {
  const r = forward(0);
  assert.equal(r.T, 288.15);
  assert.equal(r.p, 101325);
  assert.equal(r.layerIndex, 0);
  assert.equal(r.formula, "nonzero-lapse");
});

test("手算海平面密度 rho = p/(R*T)", () => {
  const r = forward(0);
  const expected = 101325 / (287.05287 * 288.15);
  assert.ok(Math.abs(r.rho - expected) < 1e-12);
  assert.ok(Math.abs(r.rho - 1.225) < 1e-3);
});

test("11000 m 与 20000 m 均为 216.65 K，压力继续降低", () => {
  const r11 = forward(11000);
  const r20 = forward(20000);
  assert.ok(Math.abs(r11.T - 216.65) < 1e-9);
  assert.ok(Math.abs(r20.T - 216.65) < 1e-9);
  assert.ok(r20.p < r11.p);
  assert.equal(r11.layerIndex, 1);
  assert.equal(r20.layerIndex, 2);
  assert.equal(r11.formula, "isothermal");
});

test("32000 m 温度为 228.65 K，归最后一层", () => {
  const r = forward(32000);
  assert.ok(Math.abs(r.T - 228.65) < 1e-9);
  assert.equal(r.layerIndex, 2);
});

test("等温层压力比与手算 exp(-g*dh/(R*T)) 一致", () => {
  const ratio = forward(20000).p / forward(11000).p;
  const expected = Math.exp((-G * 9000) / (R * 216.65));
  assert.ok(Math.abs(ratio - expected) < 1e-12);
});

test("非零梯度层与独立分段数值积分一致", () => {
  const n = 200000;
  const dh = 11000 / n;
  let lnRatio = 0;
  for (let i = 0; i < n; i++) {
    const hMid = (i + 0.5) * dh;
    const T = T0 - 0.0065 * hMid;
    lnRatio += (-G / (R * T)) * dh;
  }
  const pNum = P0 * Math.exp(lnRatio);
  const pModel = forward(11000).p;
  assert.ok(Math.abs(pNum - pModel) / pModel < 1e-9);
});

test("层界两侧连续（11000 与 20000）", () => {
  for (const hb of [11000, 20000]) {
    const eps = 1e-6;
    const below = forward(hb - eps);
    const at = forward(hb);
    const above = forward(hb + eps);
    assert.ok(Math.abs(below.p - at.p) / at.p < 1e-8, `p 在 ${hb} 不连续`);
    assert.ok(Math.abs(above.p - at.p) / at.p < 1e-8, `p 在 ${hb} 不连续`);
    assert.ok(Math.abs(below.T - at.T) < 1e-6);
    assert.ok(Math.abs(above.T - at.T) < 1e-6);
  }
});

test("层底状态逐层递推（上层底等于下层顶）", () => {
  for (let i = 1; i < LAYER_BASES.length; i++) {
    const prev = LAYER_BASES[i - 1];
    const cur = LAYER_BASES[i];
    const topH = cur.hb;
    const Tt = prev.Tb + prev.lapse * (topH - prev.hb);
    assert.ok(Math.abs(cur.Tb - Tt) < EPS);
    const r = forward(topH);
    assert.equal(r.layerBase.pb, cur.pb);
  }
});

test("压力随高度严格单调降低（全范围剖面）", () => {
  const prof = profile(0, H_MAX, 100);
  for (let i = 1; i < prof.points.length; i++) {
    assert.ok(
      prof.points[i].p < prof.points[i - 1].p,
      `p 未严格降低于 h=${prof.points[i].h}`,
    );
  }
});

test("全范围正反算往返误差", () => {
  let maxH = 0;
  let maxRelP = 0;
  for (let h = 0; h <= H_MAX; h += 25) {
    const p = forward(h).p;
    const inv = inverse(p);
    maxH = Math.max(maxH, Math.abs(inv.h - h));
    maxRelP = Math.max(maxRelP, Math.abs(inv.forwardCheck.relativeResidual));
    assert.ok(inv.forwardCheck.heightInRange);
  }
  assert.ok(maxH < 1e-6, `高度往返误差过大: ${maxH}`);
  assert.ok(maxRelP < 1e-9, `压力残差过大: ${maxRelP}`);
});

test("反算端点：p0 -> 0，P_TOP -> 32000，层界压力归更高一层", () => {
  assert.ok(Math.abs(inverse(P0).h) < 1e-9);
  const top = inverse(P_TOP);
  assert.ok(Math.abs(top.h - H_MAX) < 1e-6);
  assert.equal(top.layerIndex, 2);
  const p11 = LAYER_BASES[1].pb;
  const inv11 = inverse(p11);
  assert.equal(inv11.layerIndex, 1);
  assert.ok(Math.abs(inv11.h - 11000) < 1e-6);
});

test("非法输入：负高度、超范围高度、非有限值、范围外压力", () => {
  assert.throws(
    () => forward(-1),
    (e: unknown) => e instanceof AtmosphereError && e.code === "HEIGHT_OUT_OF_RANGE",
  );
  assert.throws(
    () => forward(32001),
    (e: unknown) => e instanceof AtmosphereError && e.code === "HEIGHT_OUT_OF_RANGE",
  );
  assert.throws(
    () => forward(NaN),
    (e: unknown) => e instanceof AtmosphereError && e.code === "INVALID_INPUT",
  );
  assert.throws(
    () => inverse(0),
    (e: unknown) => e instanceof AtmosphereError && e.code === "INVALID_INPUT",
  );
  assert.throws(
    () => inverse(-5),
    (e: unknown) => e instanceof AtmosphereError && e.code === "INVALID_INPUT",
  );
  assert.throws(
    () => inverse(P0 + 1),
    (e: unknown) => e instanceof AtmosphereError && e.code === "PRESSURE_OUT_OF_RANGE",
  );
  assert.throws(
    () => inverse(P_TOP / 2),
    (e: unknown) => e instanceof AtmosphereError && e.code === "PRESSURE_OUT_OF_RANGE",
  );
});

test("剖面包含起止端点，步长不整除时报告最后短段", () => {
  const prof = profile(0, 1000, 300);
  assert.equal(prof.points[0].h, 0);
  assert.equal(prof.points[prof.points.length - 1].h, 1000);
  assert.ok(prof.lastShortSegment !== null && Math.abs(prof.lastShortSegment - 100) < 1e-9);
  const even = profile(0, 1000, 250);
  assert.equal(even.lastShortSegment, null);
});

test("剖面点数上限，不生成无界剖面", () => {
  assert.throws(
    () => profile(0, H_MAX, 1),
    (e: unknown) => e instanceof AtmosphereError && e.code === "LIMIT_EXCEEDED",
  );
  assert.throws(
    () => profile(0, 100, 0),
    (e: unknown) => e instanceof AtmosphereError && e.code === "INVALID_INPUT",
  );
});

test("加密剖面不改变同一高度结果", () => {
  const coarse = profile(0, 32000, 8000);
  const fine = profile(0, 32000, 1000);
  const fineAt = new Map(fine.points.map((p) => [p.h, p]));
  for (const pt of coarse.points) {
    const f = fineAt.get(pt.h);
    assert.ok(f, `细剖面缺少 h=${pt.h}`);
    assert.equal(f.p, pt.p);
    assert.equal(f.T, pt.T);
  }
});

test("SQLite 幂等与重启持久化", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atmo-test-"));
  try {
    const db1 = new AtmoDb(dir);
    const r = forward(11000);
    const a = db1.record("forward", { h: 11000 }, "m", r.rulesVersion, r, {});
    const b = db1.record("forward", { h: 11000 }, "m", r.rulesVersion, r, {});
    assert.equal(a.id, b.id);
    assert.equal(db1.count(), 1);
    const p5 = forward(5000).p;
    const inv = inverse(p5);
    db1.record("inverse", { p: p5 }, "Pa", inv.rulesVersion, inv, inv.forwardCheck);
    db1.close();
    const db2 = new AtmoDb(dir);
    assert.equal(db2.count(), 2);
    const hist = db2.history(10);
    const invRec = hist.find((q) => q.kind === "inverse");
    assert.ok(invRec, "重启后应能复查反算记录");
    const savedInv = JSON.parse(invRec!.result);
    const savedReport = JSON.parse(invRec!.report);
    assert.ok(Math.abs(savedInv.h - 5000) < 1e-6);
    assert.ok("pressureResidual" in savedReport, "报告应含反算残差");
    const fwdRec = hist.find((q) => q.kind === "forward");
    const savedFwd = JSON.parse(fwdRec!.result);
    assert.equal(savedFwd.layerBase.pb, LAYER_BASES[1].pb);
    db2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
