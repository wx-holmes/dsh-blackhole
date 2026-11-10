# 黑洞（dsh-blackhole）· 压缩即归档

给长会话做「压缩即归档」的 DSH 插件：上下文涨到**事件视界**时自动压缩，被压掉的原文**逐字**落到本地归档区，同时生成可按会话 / 日期检索的索引；需要时能把原文找回来。

解决的问题很具体：长任务里压缩上下文一定会丢东西，丢了就再也找不回。大多数方案只保证「摘要还在」，黑洞还要保证「原文也在」。

## 它怎么工作

1. **阈值三段**
   - `eventHorizon`（默认 0.6）：上下文占比到这里，开始压缩并归档。
   - `solidifyLine`（默认 0.75）：固化线，过了就不再指望还能压回去。
   - `hardCap`（默认 0.9）：硬上限。
2. **窄段门槛**：`minCompactEvents` / `minCompactTokens`（默认 2 条事件或 2000 token）。前缀太窄时摘要压不小，白烧一次调用还留一份废件，所以先跳过，等它自然变宽。
3. **归档**：被压掉的原文按会话、日期分段写进 `archiveRoot`，文件名带段号与摘要，正文是**逐字原文**，不是再压缩过的版本。
4. **索引**：同目录下 `index.md`（人读）与 `index.jsonl`（机器读）一行一段，记录：哪个会话、哪天、压了哪几段、原文在哪个文件。
5. **找回**：需要旧内容时，从索引查到原文路径，直接读文件。
6. **事件流**：压缩生命周期里追加 `compact.archived` / `compact.skipped` / `archive.failed` 三类事件，别的插件可以按 offset 增量读，接进自己的账本。

## 0.3.0 加了什么

- **冷库读端（`bh_restore_span`）**：按「会话 + seq 区间」从原文库取回，返回 `digest`（逐字校验用）和 `latencyMs`；每次取回写一条 `recall.hit` 事件，谁在什么时候取了哪一段都可查。
- **块仓（`bh_compress` / `bh_restore` / `bh_search`）**：任意文本可逆存取，带 `source`/`tags`，不依赖模型；适合作业中间产物、日志片段。
- **按天轮换视界（`dailyHorizon`）**：`{start, ratios}` 按天数取档位，跨零点自动切换，不用重启。
- **按会话覆盖档位（`sessionRatios`）**：给特别忙的会话单独设线（例如单步协议会话设 0.5，别人仍是全局档）。
- **折叠冷却（`foldCooldownMs` / `foldCooldownMax`）**：同会话在窗口内最多折 N 次，治「折一段、几分钟长回来」的追尾；计数落盘跨重启。配两条放行（连续被拦 8 次、或 tokens 到硬顶 95%），宁可多折一次也不把会话憋爆。
- **采样（`sampleFile`）**：每轮记一行表面大小、折叠耗时、剪枝收益，用来算「一次折叠省了多少 surface、花了多少」。
- **卡片补「为什么」**：每张索引卡除了「起点/收尾/工具」，加一行 `rationale`（从原文抽出带因果/取舍的原话，不改写）和 `pointer`（回取指针），解决「压缩后只剩骨架、决策依据没了」。
## 配置

```yaml
- insert:
    - id: blackhole
      name: dsh-blackhole
      config:
        eventHorizon: 0.6        # 事件视界
        solidifyLine: 0.75       # 固化线
        hardCap: 0.9             # 硬上限
        thresholdRatio: 0.6
        retainRatio: 0.16        # 保留近期内容不压
        archiveRoot: "D:\\archive\\context"   # 原文真源（改成你自己的目录）
        stateRoot: "D:\\archive\\state"       # 插件状态/缓存（可重建）
        pendingTtlMs: 600000
        minCompactEvents: 2
        minCompactTokens: 2000
```

`archiveRoot` 是原文的家，**建议放在你不想丢的盘上**；`stateRoot` 丢了可以重建。

## 安装

1. 把本目录放到你的 dsh profile 能加载的位置（`node_modules/dsh-blackhole`，或插件目录后在 cordis 层里引用）。
2. 在 profile 的层配置里加上面那段 `insert`。
3. 重启 dsh，日志里应出现插件激活。

## 目录结构（archiveRoot 下）

```
archiveRoot/
├── 索引.md            人读索引：会话 / 日期 / 段 / 原文路径
├── index.jsonl       机器读索引：一行一段
├── README.md         归档区规则
└── originals/        原文分段文件（逐字）
```

## 状态与边界

- 0.3.0，自用中；Windows 上跑得最多，其他平台没验证过。
- 只在「压缩」发生时归档，不会主动扫描历史会话。
- 写盘是同步的：宁可慢一点，也不接受「摘要写了、原文没写」。
- 测试：`npm test`（archive / blocks / cards / coldstore / events / fade / fold-cooldown / gate / heartbeat / logic / pipeline / region / rotation / rotation-refresh / session-ratio / tools，共 16 组，全绿）。

## 想找人帮忙的地方

- 怎么把它做成「别人也能装」的版本：发布流程、跨平台路径处理、以及跟宿主版本升级的兼容策略。
- 归档检索还只有文件索引，想听听有没有更省事的做法。
