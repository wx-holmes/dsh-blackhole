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

- 0.1.0，自用中；Windows 上跑得最多，其他平台没验证过。
- 只在「压缩」发生时归档，不会主动扫描历史会话。
- 写盘是同步的：宁可慢一点，也不接受「摘要写了、原文没写」。
- 测试：`npm test`（archive / logic / gate / events / pipeline 五组）。

## 想找人帮忙的地方

- 怎么把它做成「别人也能装」的版本：发布流程、跨平台路径处理、以及跟宿主版本升级的兼容策略。
- 归档检索还只有文件索引，想听听有没有更省事的做法。
