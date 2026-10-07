# 分层标准大气压力高度换算后端（教学用，0–32000 m 位势高度）

TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`）实现的本地后端，仅提供 HTTP API 与 CLI。
不依赖 Docker、WSL、付费服务或任何外部在线 API；除开发依赖 `typescript` / `@types/node` 外无运行时依赖。

## 模型定义

- 输入高度一律为**位势高度**（geopotential height），单位米。本服务不把几何海拔直接当作位势高度，也不做两者换算。
- 固定常数（随规则版本 `ISA-0474-v1` 冻结，不受环境变量影响）：
  - `g = 9.80665 m/s^2`，`R = 287.05287 J/(kg·K)`
  - 海平面 `T0 = 288.15 K`，`p0 = 101325 Pa`
- 层表（层界高度 0 / 11000 / 20000 / 32000 m）：

  | 层 | 高度范围 (m) | 温度梯度 L (K/m) |
  |---|---|---|
  | 0 | 0 – 11000 | -0.0065 |
  | 1 | 11000 – 20000 | 0（等温） |
  | 2 | 20000 – 32000 | +0.001 |

- 温度使用开尔文；摄氏度仅用于显示，不进入气压公式。密度 `rho = p / (R · T)`。

## 公式与递推

层底状态从首层逐层递推：上层的 `Tb`、`pb` 取下层顶端的计算结果，不重新套海平面值，也不做提前舍入。
层内 `Δh = h - hb`，`T = Tb + L·Δh`：

- `L ≠ 0`：`p = pb · (T/Tb)^(-g/(R·L))`
- `L = 0`（等温）：`p = pb · exp(-g·Δh/(R·Tb))`（单独分支，不存在零梯度除零）

反算为解析式（不查表、不迭代）：

- `L ≠ 0`：`h = hb + (Tb·(p/pb)^(-R·L/g) − Tb) / L`
- `L = 0`：`h = hb − R·Tb·ln(p/pb)/g`

每次反算都会把结果代回正向模型，返回压力残差与高度范围检查。

## 边界归属与校验

- 恰好位于内部层界（11000 / 20000 m）归**更高一层**；顶端 32000 m 归最后一层。正算与反算使用同一约定，两侧求值连续。
- `h = 0` 与 `h = 32000` 均允许；范围外明确拒绝（错误码 `HEIGHT_OUT_OF_RANGE`），不向外套用末层公式。
- 反算压力必须为正且位于 `[P_TOP, 101325] Pa`（`P_TOP ≈ 868.016 Pa`），否则 `PRESSURE_OUT_OF_RANGE`。显示舍入后的数值不保证恰好命中内部层界。
- 所有结果校验温度为正且有限，不以零压力掩盖下溢。

## 运行

```powershell
npm install        # 安装开发依赖（typescript）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API（默认端口 0 = 自动选择空闲端口）
npm run demo       # 演示关键高度与反算
```

要求 Node.js ≥ 22.5（内置 `node:sqlite`；开发环境为 Node 25）。数据保存在项目内 `data/atmosphere.db`。

## CLI

```
node dist/src/cli.js h 11000                 # 单高度正算
node dist/src/cli.js p 22632.04              # 气压反算（含正向复核残差）
node dist/src/cli.js profile --from 0 --to 32000 --step 1000 [--csv]
node dist/src/cli.js layers                  # 层界、层底状态与公式
node dist/src/cli.js constants               # 常数与规则版本
node dist/src/cli.js history --limit 20      # SQLite 查询历史
node dist/src/cli.js serve --port 8080       # 指定端口；缺省 0 = 空闲端口
```

剖面必含起止端点；步长不整除区间时末尾补终点并在 `lastShortSegment` 说明最后短段，不改变公式。
采样点上限 10001，批量上限 1000 项，不生成无界剖面。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/atmosphere?h=11000` | 单高度正算 |
| GET | `/api/inverse?p=22632.04` | 气压反算（返回正向复核残差） |
| GET | `/api/profile?from=0&to=32000&step=1000[&format=csv]` | 剖面，JSON 或 CSV |
| GET | `/api/export?to=32000&step=1000` | 同 profile，默认 CSV |
| POST | `/api/batch` | `{"heights":[...],"pressures":[...]}`，逐项标记错误，正常项不丢 |
| GET | `/api/layers` / `/api/constants` | 层界与公式参数 |
| GET | `/api/history?limit=50` | 历史记录（含未舍入结果与报告） |
| GET | `/api/health` | 健康检查 |

错误响应统一为 `{"ok":false,"error":{"code","message"}}`，错误码：
`INVALID_INPUT`、`HEIGHT_OUT_OF_RANGE`、`PRESSURE_OUT_OF_RANGE`、`LIMIT_EXCEEDED`、`NOT_FOUND`、`INTERNAL`。

## 持久化与幂等

每次成功查询把原始输入、单位、规则版本、未舍入结果与校验报告写入 SQLite。
相同 kind + 输入 的重复请求按 SHA-256 哈希幂等去重（`INSERT OR IGNORE`），重启后可通过
`history` 复查原始层底压力与反算残差。

## 测试覆盖

`npm test` 覆盖：海平面精确值与手算密度、等温层压力比手算、非零梯度层独立数值积分核对、
层界两侧连续性、层底递推一致性、压力严格单调、全范围正反算往返误差、反算端点与边界归层、
非法负高度与范围外压力、剖面端点/短段/上限、加密剖面结果一致性、SQLite 幂等与重启持久化。

## 模型局限

- 这是固定的教学用标准大气模型：不读取天气、不做湿空气/焓、不做飞行导航、不做真实海拔校准或设备控制。
- 由标准气压反算的高度**不是**真实当天海拔；实际气压随天气变化，航空高度表需按当场 QNH/QNE 设置。
- 仅覆盖位势高度 0–32000 m；超出范围一律拒绝而非外推。
