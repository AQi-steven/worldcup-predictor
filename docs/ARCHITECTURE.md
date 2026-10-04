# 架构与数据流

## 整体结构

```
[比分源 worldcup26.ir]  ──拉取──►  [score-poller.js 守护]
                                    │  计算积分
                                    ▼
                            [npoint.io JSON 文档]  ◄──提交预测/留言──  [app/index.html 用户]
                                    │
                                    ▼
                            [gen_data_snapshot.js]  ──►  app/data.js（同源快照，供前端离线/微信渲染）
```

## 数据模型（npoint 文档）

| 字段 | 含义 |
|:---|:---|
| `predictions` / `predictions_B` | A、B 两组的用户比分预测（按比赛 + 用户名） |
| `comments_A` / `comments_B` | 留言 |
| `scores` | 已结算的真实比分与积分 |

## 积分规则（要点）

- 基础分：完美命中 5 / 净胜球对 4 / 方向对 3 / 参与 1。
- 倍率随阶段递增：小组赛 1 → 16 强 2 → 8 强 3 → 4 强 4 → 决赛 5 → 总决赛 6。
- 8 强起猜中任一方比分额外 +0.5。
- 写回前按唯一键合并保护，且用历史水位线（high-watermark）拒绝"预测数骤降"的危险写回。

## 关键文件说明

- `server/score-poller.js`：守护进程，开机同步 + 每日 12:00 兜底；单实例锁、全局异常捕获。
- `app/index.html`：前端主程序，含微信 webview 防御（本地快照优先 + fetch 硬超时）。注意其 `APP_VER` 升版逻辑。
- `tools/canonicalize.js`：名册归一化、乱码白名单修复（绝不 splice 删人）。
- `tools/gen_data_snapshot.js`：从 npoint 拉全量数据落地为 `app/data.js`。

> 本仓库为脱敏模板，npoint ID、微信地址、云凭据均为占位符，真实业务数据未入库。
