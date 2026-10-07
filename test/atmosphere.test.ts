import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  G, R, T0, P0, H_MAX, LAYER_BASES,
  forward, inverse, profile, layerIndexForHeight, AtmosphereError,
} from "../src/atmosphere";
import { Store } from "../src/db";
import { Service } from "../src/service";

test("sea level exact values", () => {
  const r = forward(0);
  assert.equal(r.T, 288.15);
  assert.equal(r.p, 101325);
  assert.equal(r.layerIndex, 0);
  assert.ok(Math.abs(r.rho - 101325 / (287.05287 * 288.15)) < 1e-12);
});

test("layer boundary temperatures and top", () => {
  assert.ok(Math.abs(forward(11000).T - 216.65) < 1e-9);
  assert.ok(Math.abs(forward(20000).T - 216.65) < 1e-9);
  assert.ok(Math.abs(forward(32000).T - 228.65) < 1e-9);
  assert.ok(forward(20000).p < forward(11000).p);
  assert.ok(forward(32000).p < forward(20000).p);
});

test("layer bases recursion matches hand calc", () => {
  assert.equal(LAYER_BASES[0].pb, P0);
  assert.ok(Math.abs(LAYER_BASES[1].Tb - 216.65) < 1e-9);
  const p11 = P0 * Math.pow(216.65 / T0, -G / (R * -0.0065));
  assert.ok(Math.abs(LAYER_BASES[1].pb - p11) < 1e-6);
  const ratio = Math.exp((-G * 9000) / (R * 216.65));
  assert.ok(Math.abs(LAYER_BASES[2].pb / LAYER_BASES[1].pb - ratio) < 1e-12);
});

test("independent numerical integration matches analytic pressure", () => {
  for (const target of [5000, 11000, 20000, 32000]) {
    const n = 200000;
    const dh = target / n;
    let p = P0;
    for (let i = 0; i < n; i++) {
      const h = (i + 0.5) * dh;
      const T = forward(h).T;
      p *= Math.exp((-G * dh) / (R * T));
    }
    const analytic = forward(target).p;
    assert.ok(Math.abs(p / analytic - 1) < 1e-6, `h=${target}: numeric ${p} vs analytic ${analytic}`);
  }
});

test("boundary layer assignment and continuity", () => {
  assert.equal(layerIndexForHeight(11000), 1);
  assert.equal(layerIndexForHeight(20000), 2);
  assert.equal(layerIndexForHeight(32000), 2);
  assert.equal(layerIndexForHeight(0), 0);
  for (const hb of [11000, 20000]) {
    const below = forward(hb - 1e-7);
    const at = forward(hb);
    const above = forward(hb + 1e-7);
    assert.ok(Math.abs(below.p - at.p) / at.p < 1e-8, `h=${hb} below discontinuity`);
    assert.ok(Math.abs(above.p - at.p) / at.p < 1e-8, `h=${hb} above discontinuity`);
    assert.ok(Math.abs(below.T - at.T) < 1e-6);
  }
});

test("out of range height rejected", () => {
  assert.throws(() => forward(-1), (e: unknown) => e instanceof AtmosphereError && (e as AtmosphereError).code === "E_HEIGHT_OUT_OF_RANGE");
  assert.throws(() => forward(32000.001), /超出模型范围/);
  assert.throws(() => forward(NaN), AtmosphereError);
});

test("inverse endpoints and boundary pressures", () => {
  assert.ok(Math.abs(inverse(101325).h - 0) < 1e-9);
  const pTop = forward(H_MAX).p;
  const rTop = inverse(pTop);
  assert.ok(Math.abs(rTop.h - H_MAX) < 1e-6);
  assert.ok(rTop.hInRange);
  assert.equal(inverse(LAYER_BASES[1].pb).layerIndex, 1);
  assert.equal(inverse(LAYER_BASES[2].pb).layerIndex, 2);
  assert.ok(Math.abs(inverse(LAYER_BASES[1].pb).h - 11000) < 1e-6);
});

test("invalid pressure rejected", () => {
  assert.throws(() => inverse(0), (e: unknown) => (e as AtmosphereError).code === "E_PRESSURE_NOT_POSITIVE");
  assert.throws(() => inverse(-5), AtmosphereError);
  assert.throws(() => inverse(101325.01), (e: unknown) => (e as AtmosphereError).code === "E_PRESSURE_OUT_OF_RANGE");
  assert.throws(() => inverse(forward(H_MAX).p - 1e-9), AtmosphereError);
});

test("pressure strictly decreases with height", () => {
  let prev = Infinity;
  for (let h = 0; h <= 32000; h += 137) {
    const p = forward(h).p;
    assert.ok(p < prev, `h=${h} pressure not decreasing`);
    prev = p;
  }
});

test("full-range forward/inverse roundtrip error", () => {
  let maxRel = 0;
  for (let h = 0; h <= 32000; h += 10) {
    const p = forward(h).p;
    const r = inverse(p);
    const err = Math.abs(r.h - h);
    assert.ok(err < 1e-6, `h=${h} roundtrip err ${err}`);
    maxRel = Math.max(maxRel, Math.abs(r.residualPRel));
  }
  assert.ok(maxRel < 1e-12, `max relative pressure residual ${maxRel}`);
});

test("profile endpoints, short segment, densification consistency", () => {
  const p1 = profile(0, 10000, 3000);
  assert.equal(p1.points[0].h, 0);
  assert.equal(p1.points[p1.points.length - 1].h, 10000);
  assert.ok(p1.lastShortSegment);
  const p2 = profile(0, 10000, 1000);
  assert.ok(!p2.lastShortSegment);
  const a = profile(0, 32000, 1000).points.find((pt) => pt.h === 15000)!;
  const b = profile(0, 32000, 250).points.find((pt) => pt.h === 15000)!;
  assert.equal(a.p, b.p);
  assert.equal(a.T, b.T);
  assert.throws(() => profile(0, 32000, 1), (e: unknown) => (e as AtmosphereError).code === "E_PROFILE_TOO_LARGE");
});

test("sqlite idempotency, batch item errors, restart persistence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "isa-test-"));
  let store = new Store(dir);
  let service = new Service(store);
  const r1 = service.height(5000);
  const r2 = service.height(5000);
  assert.ok(r1.ok && r2.ok);
  assert.equal(r1.recordId, r2.recordId);
  assert.ok(r2.deduplicated);
  const batch = service.batch([0, -5, 11000, 40000]);
  assert.equal(batch.items.filter((i) => i.ok).length, 2);
  assert.equal(batch.items.filter((i) => !i.ok).length, 2);
  const inv = service.pressure(forward(12345).p);
  assert.ok(inv.ok);
  store.close();
  store = new Store(dir);
  const records = store.list(100);
  assert.ok(records.length >= 3);
  const invRecord = records.find((r) => r.type === "inverse")!;
  const saved = JSON.parse(invRecord.resultJson!);
  assert.ok(Math.abs(saved.residualP) < 1e-6);
  assert.equal(saved.base.pb, LAYER_BASES[saved.layerIndex].pb);
  const errRecord = records.find((r) => r.type === "batch")!;
  const items = JSON.parse(errRecord.resultJson!);
  assert.equal(items[1].error.code, "E_HEIGHT_OUT_OF_RANGE");
  store.close();
});
