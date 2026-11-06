# 黑洞（dsh-blackhole）

> 压缩即归档：被压缩掉的原文**逐字**落盘，摘要只是入口，原文永远能找回。

给 [DSH](https://github.com/deepseek-ai/deepseek-harness) 长会话做的压缩后端。大多数上下文压缩方案只保证「摘要还在」；黑洞多保证一件事：**原文也在**。

## 为什么

长任务里上下文一定会到线，到线就要压缩，压缩就会丢细节。丢了以后你问「三天前那个决定是怎么来的」，模型只能编。

黑洞的思路借了物理：**事件视界不是删除，而是把信息移到看不见的地方**。所以它在压缩前先把这一段逐字写进归档区、生成索引卡，然后才让摘要顶替原文。要回溯时，从索引查到原文文件，或者用 `bh_search` / `bh_restore` 直接取。

## 它做什么

1. **三段阈值**：`eventHorizon`（到这个占比开始压）→ `solidifyLine`（固化线）→ `hardCap`（硬上限）。
2. **窄段门槛**：`minCompactEvents` / `minCompactTokens` 以下不压——前缀太窄时摘要压不小，白烧一次调用。
3. **单次折叠上限**：一段超过 `maxFoldTokens`（默认 35 万）时只折最老的一段，剩下的下一轮继续。切点按宿主 `tool-pairing` 的配平口径选（零个未完成工具调用才算合法边界），所以不会把「调用 + 结果」拆开。
4. **先剪后折**：折叠前先把段内超过 `fadeMinChars` 的工具输出剪成 `头 + 标记 + 尾`。这一步不花模型、毫秒级，但摘要器要读的 token 立刻少三到五成。**归档发生在剪之前**，原文不受影响。
5. **归档**：原文按会话 / 日期分段写进 `archiveRoot`，正文逐字，文件名带区间与摘要。
6. **索引卡 + 事件流**：每折一段生成一张卡（`index.jsonl` / `索引.md`），同时追加 `compact.archived` / `compact.skipped` / `archive.failed` 事件，别的插件可按 offset 增量读。
7. **找回**：`bh_search` 搜标题与正文，`bh_restore` 按块 id 分段取回原文，`bh_status` 看账（归档数 / 跳过数 / 失败数 / 占用）。

## 安装

把本仓库放进 DSH profile 的 `node_modules`（或作为 bundle 安装），然后在 profile 的 `cordis.patch.yml` 里挂上：

```yaml
- insert:
    - id: blackhole
      name: dsh-blackhole
      config:
        eventHorizon: 0.6
        thresholdRatio: 0.6
        retainRatio: 0.2
```

仓库里的 `cordis.patch.yml` 就是一份可直接用的示例（含两处 LLM 重试白名单的补充）。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `eventHorizon` | `0.6` | 到上下文占比多少开始归档 + 压缩 |
| `solidifyLine` | `0.75` | 固化线 |
| `hardCap` | `0.9` | 硬上限 |
| `thresholdRatio` | `0.6` | 父类判定线（必须大于 `retainRatio`） |
| `retainRatio` | `0.2` | 近期内容保留比例 |
| `archiveRoot` | `~/.dsh/blackhole/archive` | 原文归档根目录 |
| `stateRoot` | `~/.dsh/blackhole/state` | 插件状态（可重建） |
| `blocksRoot` | `<stateRoot>/blocks` | `bh_*` 的原文块仓 |
| `minCompactEvents` | `2` | 窄段门槛：事件数 |
| `minCompactTokens` | `20000` | 窄段门槛：token 数 |
| `maxFoldTokens` | `350000` | 单次折叠上限 |
| `compactionRetries` | `2` | 一次请求里最多连折几段（救援用） |
| `fade` | `true` | 先剪后折开关 |
| `fadeMinChars` | `8192` | 超过多少字符的工具输出才剪 |
| `fadeHeadChars` / `fadeTailChars` | `4096` / `1024` | 剪后保留的头 / 尾 |
| `fadeMinSpanTokens` | `60000` | 段小于这个就不值得剪 |
| `sampleEveryMs` | `60000` | 视界采样节流（零模型调用） |
| `toolPrefix` | `bh` | 工具前缀 |
| `events` | `true` | 是否写 `events.jsonl` |

## 工具

| 工具 | 作用 |
| --- | --- |
| `bh_compress` | 把一段原文存进块仓，返回块 id 与摘要 |
| `bh_restore` | 按块 id 分段取回原文 |
| `bh_search` | 在块库按标题 / 摘要 / 标签检索（可扫原文） |
| `bh_status` | 块仓现状 + 压缩台账（归档 / 跳过 / 失败 / 占用） |

## 设计笔记

- **先归档，再摘要**。顺序反了就没得救：一旦摘要顶替原文，原文只剩模型里的残影。
- **切点必须合法**。宿主的 `compactRegion` 会检查区间两端「未完成的工具调用数为 0」，不合法直接抛错。黑洞用同一口径从表面头部重新数，只在合法边界落刀。
- **折叠耗时几乎全在 prefill**。所以优化只有两条路：少读（先剪废料）或少折（提高单次上限）。实测一次 115 万 token 的救援会话要 4 次串行摘要、共约 2 分钟；单次折叠读 43 万 token 约 24–30 秒。
- **保留区不能太小**。折完仍在判定线下方会引发反复折叠，把「近期原文」压没；`retainRatio` 要给固定开销（系统提示 + 工具表）和最近几十轮留出余地。

## 许可证

MIT
