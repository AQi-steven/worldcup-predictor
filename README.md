# World Cup Predictor ⚽

A small, self-hostable **World Cup score-prediction game** for a closed group of
friends or colleagues. Participants submit their score guesses for each match on
a web page; a backend daemon periodically pulls the real results from a public
score source, scores everyone according to the rules, and writes the results
back to the cloud. The frontend then shows a live leaderboard, match reports,
and "moments of glory".

> 🛡️ **This repository is a sanitized, runnable template.** All sensitive values
> (the npoint document ID, WeChat distribution URLs, cloud credentials, and real
> user predictions) have been replaced with placeholders. **It contains no real
> business data** — you supply your own configuration to make it work.

---

## ✨ Features

- 📝 **Web prediction submission** — participants pick scores for every match.
- 🏆 **Auto-scored leaderboard** — backend computes points from real results.
- 📊 **Match reports & glory moments** — front-end highlights and rankings.
- 🔄 **Resilient sync** — the poller keeps a high-watermark to avoid cascading
  mis-writes when re-syncing.
- 🧩 **Config-driven** — plug in your own storage/endpoints without touching
  business code.

---

## 🏗️ How it works

```
[ public score source, e.g. worldcup26.ir ]
        │  pull real results
        ▼
[ server/score-poller.js  daemon ]  ── scores + writes back ──►  [ npoint.io JSON store ]
        │                                                         ▲
        │ reads predictions & writes scores                       │ reads for display
        └─────────────────────────────────────────────────────────┘
                                                              [ app/index.html  frontend ]
```

- **Storage** — a JSON document on [npoint.io](https://www.npoint.io) holding
  predictions, comments, and real scores. Field convention:
  `predictions` / `predictions_B` (group A / B), `comments_A` / `comments_B`,
  `scores`.
- **Frontend** — a static `app/index.html` that reads the npoint data and
  renders the leaderboard. Because npoint does not send CORS headers, production
  setups usually pair it with a same-origin `data.js` snapshot.
- **Backend** — `server/score-poller.js`, a daemon that pulls results on a
  schedule, applies the scoring rules, and writes back.
- **Tooling** — `tools/` holds a batch of data-governance and ops scripts
  (sync, cleanup, dedup, recalc, upload protection, backend migration).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full data-flow write-up.

---

## 📁 Project structure

```
worldcup-predictor/
├── app/                      # Frontend (open index.html in a browser)
│   ├── index.html            # Main app: submit predictions / leaderboard / reports
│   ├── match_data.js         # Match schedule & team data (sample)
│   ├── new_fn.js             # Frontend helpers
│   ├── data.example.js       # Prediction-snapshot shape (real data.js is gitignored)
│   └── config.js.example     # Config template (copy to config.js and fill in)
├── server/
│   └── score-poller.js       # Backend daemon: fetch scores, score, write back
├── tools/                   # Data sync / cleanup / scoring / ops scripts
│   ├── sync-scores.js / update-scores.js / fetch_games.js
│   ├── gen_data_snapshot.js / daily-snapshot.js / daily-planner.js
│   ├── canonicalize.js / clean_write.js / cleanup_normalize.js / cleanup_empty8.js
│   ├── copy_a_to_b.js / mirror_a_to_b.js / clear_peeks_b.js
│   ├── recalc-pts.js
│   ├── health_check.js / safe_upload.js / upload_fixed.js / upload_fixed_v2.js
│   ├── migrate_to_cloudbase.js / migrate_to_leancloud.js
│   ├── score-watcher.js / schedule_sync.ps1 / run-sync.bat
│   └── calibrate_knockout.py / check_all_users.py / convert_to_js.py
├── docs/
│   └── ARCHITECTURE.md       # Architecture & data-flow notes
├── .env.example             # Node script env-template
├── LICENSE                  # MIT
└── .gitignore
```

---

## 🚀 Quick start

### Prerequisites
- [Node.js](https://nodejs.org) (the scripts were built on Node 22)
- An [npoint.io](https://www.npoint.io) document to act as your data store

### 1. Set up storage
Create a JSON document on npoint.io and copy its **document ID**.

### 2. Configure the frontend
```bash
cp app/config.js.example app/config.js
# then edit app/config.js and set your npointId
```

### 3. Configure the Node scripts
```bash
cp .env.example .env
# then edit .env and set NPOINT_ID (plus cloud credentials if you use migration scripts)
```

### 4. Generate a local data snapshot
```bash
# pulls from npoint and writes app/data.js (gitignored)
node tools/gen_data_snapshot.js
```

### 5. Run the backend daemon
```bash
node server/score-poller.js --once     # run a single sync
node server/score-poller.js            # stay resident (syncs daily at 12:00 Beijing time)
```

---

## 🔧 Configuration reference

ID/endpoint reading is unified and config-aware — Node scripts read
`process.env`, the frontend reads `window.CONFIG`, so you can wire in your own
environment without changing business code:

```js
const NPOINT_ID = (typeof process !== 'undefined' && process.env && process.env.NPOINT_ID)
  || (typeof window !== 'undefined' && window.CONFIG && window.CONFIG.npointId)
  || 'REPLACE_WITH_NPOINT_ID';
```

| What | Placeholder | Where to set |
|:---|:---|:---|
| npoint document ID | `REPLACE_WITH_NPOINT_ID` | `app/config.js` + `.env` (`NPOINT_ID`) |
| WeChat distribution URL A/B | `REPLACE_WITH_WX_URL_A/B` | source / config |
| CloudBase credentials | `REPLACE_WITH_CLOUDBASE_SECRET_ID/KEY` | `.env` (migration scripts only) |
| worldcup26.ir API token | `REPLACE_WITH_WC26_API_TOKEN` | `.env` (`WC26_API_TOKEN`, `tools/fetch_games.js`) |
| Bot password | `REPLACE_WITH_BOT_PASSWORD` | `.env` (`WC26_BOT_PASSWORD`, `tools/update-scores.js`) |
| Real user predictions | removed (not in repo) | `app/data.js` (generated locally) |

---

## 📄 License

Released under the [MIT License](LICENSE).

---

## 🇨🇳 中文说明

一个**可自托管的小世界杯比分竞猜系统**，适合小圈子（朋友 / 同事）一起玩。参与者在网页上提交每场比赛的比分预测；后端守护进程定期从公开数据源拉取真实赛果，按规则给每人算分，并写回云端；前端随即展示实时排行榜、战报与"荣耀时刻"。

> 🛡️ **本仓库是「脱敏后的可运行模板」**。所有敏感信息（npoint 文档 ID、微信分发地址、云凭据、真实用户预测）都已替换为占位符，**不含任何真实业务数据**——你只需填入自己的配置即可运行。

### ✨ 功能

- 📝 **网页提交预测** —— 参与者为每场比赛填比分。
- 🏆 **自动计分排行榜** —— 后端依据真实赛果算分。
- 📊 **战报与荣耀时刻** —— 前端高亮展示排名与精彩瞬间。
- 🔄 **健壮同步** —— 轮询器保留高水位，重同步时避免连锁误写。
- 🧩 **配置驱动** —— 可接入自己的存储 / 接口，无需改动业务代码。

### 🏗️ 工作原理

```
[ 公开比分源，如 worldcup26.ir ]
        │  拉取真实赛果
        ▼
[ server/score-poller.js 守护进程 ] ── 算分 + 写回 ──► [ npoint.io JSON 存储 ]
        │                                                    ▲
        │ 读取预测 & 写入积分                                │ 读取用于展示
        └────────────────────────────────────────────────────┘
                                                       [ app/index.html 前端 ]
```

- **存储**：[npoint.io](https://www.npoint.io) 上的 JSON 文档，保存预测、留言与真实赛果。字段约定：`predictions` / `predictions_B`（A/B 组）、`comments_A` / `comments_B`、`scores`。
- **前端**：静态 `app/index.html`，读取 npoint 数据并渲染排行榜。由于 npoint 不返回 CORS 头，生产环境通常配合同源的 `data.js` 快照使用。
- **后端**：`server/score-poller.js`，按计划拉取赛果、应用计分规则并写回。
- **工具**：`tools/` 下是一批数据治理与运维脚本（同步、清洗、去重、重算、上传保护、后端迁移）。

完整数据流见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

### 📁 项目结构

```
worldcup-predictor/
├── app/                      # 前端（浏览器直接打开 index.html）
│   ├── index.html            # 主程序：提交预测 / 排行榜 / 战报
│   ├── match_data.js         # 赛程与球队数据（示例）
│   ├── new_fn.js             # 前端辅助函数
│   ├── data.example.js       # 预测快照结构（真实 data.js 已被 gitignore）
│   └── config.js.example     # 配置模板（复制为 config.js 后填写）
├── server/
│   └── score-poller.js       # 后端守护进程：拉取赛果、算分、写回
├── tools/                   # 数据同步 / 清洗 / 计分 / 运维脚本
├── docs/
│   └── ARCHITECTURE.md       # 架构与数据流说明
├── .env.example             # Node 脚本环境变量模板
├── LICENSE                  # MIT
└── .gitignore
```

### 🚀 快速开始

**前置条件**
- [Node.js](https://nodejs.org)（脚本基于 Node 22 构建）
- 一个 [npoint.io](https://www.npoint.io) 文档作为数据存储

**1. 准备存储** —— 在 npoint.io 创建一个 JSON 文档，复制它的**文档 ID**。

**2. 配置前端**
```bash
cp app/config.js.example app/config.js
# 编辑 app/config.js，填入你的 npointId
```

**3. 配置 Node 脚本**
```bash
cp .env.example .env
# 编辑 .env，填入 NPOINT_ID（如使用迁移脚本还需填云凭据）
```

**4. 生成本地数据快照**
```bash
node tools/gen_data_snapshot.js   # 从 npoint 拉取并生成 app/data.js（已被 gitignore）
```

**5. 运行后端守护进程**
```bash
node server/score-poller.js --once     # 单次同步
node server/score-poller.js            # 常驻（每日北京时间 12:00 同步）
```

### 🔧 配置说明

ID / 接口地址的读取已统一并支持配置注入——Node 脚本读 `process.env`，前端读 `window.CONFIG`，无需改动业务代码即可接入自己的环境：

```js
const NPOINT_ID = (typeof process !== 'undefined' && process.env && process.env.NPOINT_ID)
  || (typeof window !== 'undefined' && window.CONFIG && window.CONFIG.npointId)
  || 'REPLACE_WITH_NPOINT_ID';
```

| 配置项 | 占位符 | 填在哪里 |
|:---|:---|:---|
| npoint 文档 ID | `REPLACE_WITH_NPOINT_ID` | `app/config.js` + `.env`（`NPOINT_ID`） |
| 微信分发地址 A/B | `REPLACE_WITH_WX_URL_A/B` | 源 / 配置 |
| CloudBase 凭据 | `REPLACE_WITH_CLOUDBASE_SECRET_ID/KEY` | `.env`（仅迁移脚本需要） |
| worldcup26.ir API Token | `REPLACE_WITH_WC26_API_TOKEN` | `.env`（`WC26_API_TOKEN`，`tools/fetch_games.js`） |
| 机器人密码 | `REPLACE_WITH_BOT_PASSWORD` | `.env`（`WC26_BOT_PASSWORD`，`tools/update-scores.js`） |
| 真实用户预测 | 已移除（不在仓库内） | `app/data.js`（本地生成） |

### 📄 许可证

基于 [MIT 许可证](LICENSE) 发布。
