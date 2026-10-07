# 分层标准大气压力高度换算与层界连续核验后端

教学用后端服务：输入**位势高度**（0–32000 m），按固定三层标准大气模型计算温度、气压、密度；也可由气压反求位势高度。仅 API 与 CLI，无前端。

## 模型与常数（随规则版本冻结）

规则版本：`ISA-LAYERED-0474-v1`。常数与层表硬编码在 `src/atmosphere.ts`，不受环境变量影响。

| 量 | 值 |
| --- | --- |
| g | 9.80665 m/s² |
| R | 287.05287 J/(kg·K) |
| T0（海平面） | 288.15 K |
| p0（海平面） | 101325 Pa |

| 层 | 层底位势高度 (m) | 温度梯度 L (K/m) |
| --- | --- | --- |
| 0 | 0 | -0.0065 |
| 1 | 11000 | 0（等温层） |
| 2 | 20000 | +0.001 |

模型顶界 32000 m。

**层底状态递推**：从海平面起逐层递推，上层的 `Tb`、`pb` 取下层顶端的计算结果（不舍入），不每层重套海平面值。

**层内公式**（`Δh = h - hb`，`T = Tb + L·Δh`）：

- L ≠ 0：`p = pb · (T/Tb)^(-g/(R·L))`
- L = 0：`p = pb · exp(-g·Δh/(R·Tb))`

密度 `ρ = p/(R·T)`，温度一律用开尔文参与计算；摄氏度仅用于显示。

**边界归属**：恰好位于内部层界（11000、20000 m）归**更高一层**；32000 m 归最后一层。反算按层界压力采用同一约定（边界压力归更高一层）。从两侧独立求值连续（有测试覆盖）。

**反算**：按各层界压力确定所属层（压力越小高度越高），非等温层由压力比反求温度再求 Δh，等温层用对数关系；无迭代、无查表近似。每次反算把结果代回正向模型，输出压力残差与高度范围检查。

## 口径与局限

- 输入高度是**位势高度**，不是几何海拔，本服务不做两者换算。
- 这是固定标准模型：不读取天气、不做湿空气/焓、不做飞行导航、不做真实海拔校准或设备控制。
- **由标准气压反算的高度不是真实当天海拔**，不能用于实际飞行或测绘。
- 超出 [0, 32000] m 的高度、超出模型两端压力的压力会被明确拒绝（错误码 `E_HEIGHT_OUT_OF_RANGE` / `E_PRESSURE_OUT_OF_RANGE`），不向外套用末层公式。

## 运行要求

- Windows 本地，Node.js ≥ 22（使用内置 `node:sqlite`，无需原生编译、Docker、WSL 或外部服务）。

## 构建、测试、启动、演示

```powershell
npm install
npm run build     # 编译到 dist/
npm test          # 编译并运行全部测试（node:test）
npm start         # 启动 API（默认自动选择空闲端口）
npm run demo      # 演示 0/11000/20000/32000 m 关键点
```

数据目录默认为项目内 `./data`（可用 `--data-dir` 或环境变量 `ATM_DATA_DIR` 覆盖），SQLite 文件为 `data/atmosphere.sqlite`。

## CLI

```
node dist/cli.js serve [--port N]         # 默认端口 0 = 自动选空闲端口
node dist/cli.js height <h>               # 位势高度 -> T/p/rho
node dist/cli.js inverse <p>              # 压力 -> 高度（含残差核验）
node dist/cli.js profile <from> <to> <step> [--format json|csv]
node dist/cli.js batch <h1,h2,...>        # 批量正算，逐项标记错误
node dist/cli.js layers                   # 层界与层底状态
node dist/cli.js constants                # 冻结常数与公式参数
node dist/cli.js records [--limit N] [--format json|csv]
node dist/cli.js export --format json|csv
node dist/cli.js demo
```

## API（默认监听 127.0.0.1，端口见启动日志）

| 方法与路径 | 说明 |
| --- | --- |
| GET `/api/health` | 健康检查与规则版本 |
| GET `/api/constants` | 冻结常数与层表 |
| GET `/api/layers` | 层界与递推后的层底状态 |
| GET `/api/atmosphere?h=11000` | 单高度正算（含层底状态、温度比、指数、公式来源） |
| GET `/api/inverse?p=22632` | 压力反算（含残差与范围核验） |
| GET `/api/profile?from=0&to=32000&step=1000[&format=csv]` | 剖面（必含端点；步长不整除时最后为短段并标记） |
| POST `/api/batch` `{"heights":[...]}` | 批量正算，逐项 ok/error |
| GET `/api/records?limit=100[&format=csv]` | 历史查询记录 |
| GET `/api/records/{id}` | 单条记录（含未舍入结果与报告） |

错误返回形如 `{"error":{"code":"E_NOT_A_NUMBER","message":"..."}}`，HTTP 400。主要错误码：`E_NOT_A_NUMBER`、`E_NOT_FINITE`、`E_MISSING_PARAM`、`E_HEIGHT_OUT_OF_RANGE`、`E_PRESSURE_NOT_POSITIVE`、`E_PRESSURE_OUT_OF_RANGE`、`E_STEP_NOT_POSITIVE`、`E_BAD_RANGE`、`E_PROFILE_TOO_LARGE`、`E_BATCH_TOO_LARGE`、`E_EMPTY_BATCH`、`E_NONFINITE_RESULT`、`E_NONPOSITIVE_TEMPERATURE`、`E_NOT_FOUND`。

## 持久化与限制

- 每次请求（含失败）写入 SQLite：原始输入、单位、规则版本、未舍入结果、错误码、文字报告、时间戳。
- 幂等：同一规则版本 + 类型 + 输入的重复请求按 SHA-256 去重，返回已有记录，重启后可复查层底状态与反算残差。
- 上限：批量 ≤ 1000 项，剖面采样点 ≤ 5000，防止无界输出。

## 测试覆盖（`npm test`，12 项）

- 海平面精确值 288.15 K / 101325 Pa 与手算密度；11000/20000 m 为 216.65 K 且压力继续降低；32000 m 为 228.65 K。
- 层底递推手算核对（第一层顶压力、等温层压力比 `exp(-g·9000/(R·216.65))`）。
- 独立分段数值积分 `dp/p = -g/(R·T) dh` 与解析式对比（相对误差 < 1e-6）。
- 层界归层约定与两侧连续性；非法负高度与范围外压力拒绝。
- 压力随高度严格单调降低；全范围（步长 10 m）正反算往返误差 < 1e-6 m、压力相对残差 < 1e-12。
- 剖面端点/短段、加密剖面不改变同一高度结果、采样点上限。
- SQLite 幂等去重、批量逐项错误、重启后复查层底压力与反算残差。
