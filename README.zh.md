---
description: "B+Tree + EventId session 格式类型、存储接口与原型运行时实现：带校验和的页面、页存储、revision CAS、垃圾回收、高层引擎与 session 仓库，以及多页 B+Tree 持久化。"


kind: "package-library"
---

# @deepseek-ai/dsh-session-format

[English](README.md) | 中文

## 概述

`dsh-session-format` 拥有一种把顺序与身份分离的 session 格式词汇：Copy-on-Write B+Tree 维护事件顺序，每个事件有稳定 `EventId`，引用、fork、watermark 与公共 API 都使用 `EventId`。本包交付核心类型、存储后端接缝、内存 B+Tree 原型（`SessionTree` 的 append/rank/range-replace/split）、文件序列化、物理压缩、fork、导出/导入与旧格式迁移的操作原型，以及原型运行时实现：带校验和的页面、页存储、元数据页、revision CAS、垃圾回收、高层引擎与 `SessionRepository`，以及多页 B+Tree 持久化。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包拥有 durable 词汇与 `SessionStorage` 接缝，并交付原型运行时实现（带校验和的页面、页存储、元数据页、revision CAS、垃圾回收、高层引擎与多页 B+Tree 持久化）；不注册 Cordis 服务。它定义持久化类型、`SessionStorage` 接缝与 `SessionTree` 原型，未来的持久化 provider 会组合它们，在派生模型历史前恢复当前逻辑 session。包根入口重新导出 `BlobStore` 与 `BLOB_SEGMENT_SIZE`（格式的内存 blob 区），以及高层组合 `SessionRepository`、`SessionFormatEngine`、`PageStore` 与 `SessionStore`，使仓库可从打包产物直接构造，还有 EventId 投影 watermark 助手 `advanceProjection`、`projectionNeedsRebuild` 与 `projectionWatermarkShadowed` 及其 `ProjectionState` 类型。`SessionRepository` 是高层表面：它拥有读-改-写事务（append、compact、fork），为追加事件分配系统生成的 `EventId`/`BlobId` 对，并通过引擎的 revision compare-and-swap 发布新根。

设计记录在 proposed Agent Note [`session-physical-compaction-btree-pointer`](../../../.agents/notes/proposed/architecture/2026-08-26-session-physical-compaction-btree-pointer.zh.md) 中。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>Implementation internals — click to expand</summary>

本包当前包含：

- `src/index.ts` — 持久化词汇类型、`SessionStorage` 接缝与 session 记录结构。
- `src/btree.ts` — 内存 Copy-on-Write B+Tree 与 `SessionTree` 门面：节点携带子树大小与最大 order，`at`/`rank`/`split` 以 O(log n) 导航而非展平，order→id 映射使查找 O(1)。
- `src/file.ts` — 带 durable 边界校验的自包含 session 文件序列化，通过原子文件存储持久化。
- `src/file-store.ts` — 原子持久文件写入与 checksum 快照容器。
- `src/disk-page-store.ts` — 持久化页存储：全部页存放于单一追加式段文件，以 (segment, offset, length) 寻址，带持久化 next-id 与字节水位，两阶段写（追加，flush 时 fsync 段并推进水位），retain 时做段压缩。
- `src/disk-session-store.ts` — 持久化 session 存储：每 session 一个 JSON 记录文件，与 revision CAS 及 used-revision ABA 集合同步原子写入，通过扫描目录重建恢复。
- `src/compaction.ts` — 物理压缩事务：显式 surface 事件移除、引用重定向与被遮蔽 blob 回收。
- `src/projection.ts` — EventId watermark 投影状态、折叠与一次性 shadowed 区间重建判定（投影须为压缩前状态）。
- `src/fork.ts` — 按 `EventId` fork，继承前缀的 blobs、references 与压缩摘要。
- `src/migrate.ts` — 旧 seq 格式迁移原型（版本 0）。
- `src/pages.ts` + `src/page-store.ts` — 带校验和的页容器与页寻址存储。
- `src/multi-page.ts` — 一节点一页的 B+Tree 持久化与结构校验。
- `src/metadata.ts` — blob-map、reference 与压缩摘要元数据页。
- `src/store.ts` — 带 ABA 防护与滚动备份的 revision CAS。
- `src/gc.ts` — 基于可达性的页面垃圾回收。
- `src/repository.ts` — 拥有 append/compact/fork 事务的高层 `SessionRepository` 门面。
- `src/engine.ts` — 串联树、blob、引用与摘要持久化的高层引擎。
- `src/blob-store.ts` — 内存分段 blob 存储：2MB 段、读取返回独立拷贝、逻辑删除保留空间供后续 GC 回收。
- `src/invariant.ts` — 包属 invariant companion（有说明的空 installer）。

引擎持久化完整 `SessionFile`，`SessionRepository` 拥有高层事务；共享 durable 后端延期。包入口重导出仓库、引擎、页存储与 session 存储；底层模块仍走 `./src/*` 导入（见 Known Limitations）。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Session 物理压缩 Agent Note](../../../.agents/notes/proposed/architecture/2026-08-26-session-physical-compaction-btree-pointer.zh.md)
- [Session persistence 子系统](../../../docs/subsystems/persistence.zh.md)

<a id="model-experience"></a>
## 模型体验

无，本包提供 durable 类型、存储接口与原型运行时实现；自身不注册任何 prompt、工具或模型可见内容，未来的持久化 provider 负责所有模型相关呈现。

#### KV Cache 影响

无直接影响；缓存行为由消费该格式的持久化 provider 负责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **仅内存原型** —— 内存 B+Tree 尚未由单一 durable 多页文件格式支撑；`DiskPageStore` 改为把全部页持久化进单一追加式段文件。
- **仓库基于内存存储** —— `SessionRepository` 通过 `SessionFormatEngine` 组合内存 `PageStore`/`SessionStore`；接入 durable `file-store.ts` 快照延期。`DiskPageStore` 与 `DiskSessionStore` 与 `PageStore`/`SessionStore` 接口可直接互换，引擎与仓库现在即可跑在磁盘页与磁盘记录之上；durable `file-store.ts` 快照容器与共享 store 后端仍延期。
- **append 为 O(log n) 且增量提交** —— `append` 从持久化高水位（`nextEventCounter`、`blobIdWatermark`）铸造 EventId/BlobId，仅复制最右树路径（O(depth) 页，经 `appendEntryToTree`），追加一个 blob map 链页（`saveBlobAppends`），原地扩展绑定表，并写入瘦身后的记录（绑定表存于每会话的只增日志），随会话增长的每次追加成本恒定。`appendBatch` 以一次 flush 与一次记录提交落地 N 个事件，摊薄 fsync 成本（磁盘引擎实测 70 倍：批 100 时每事件 19.6ms 降至 0.28ms）。全量操作——注册、压缩、分支、导出/导入与直接 `engine.commitSession`——仍重写整棵树、blob map 与记录，读取（`loadSession`）组装完整文件与绑定表，因此这些仍为 O(n)。磁盘引擎的每次提交 flush（一次段 fsync 加一次 meta 原子替换）由 `appendBatch` 摊薄。读取组装完整文件并执行结构校验；归档序列化/反序列化往返只在写路径执行，不随每次读重复。
- **底层提交点派生递增值** —— 直接调用 `engine.commitSession`/`engine.compact` 必须提供严格推进的 revision 与越过文件自身 blob id 的 watermark（两者均在提交点强制）；仓库路径总是派生递增值，提交拒绝降低的计数器或低于 blob map 的 watermark，而不是信任调用方。
- **存储契约仅限 JSDoc** —— 页/blob 不可变、create-only 写入与 CAS 铸造 revision 都是接口契约，尚无后端实现，也没有按 revision 固定的读取句柄来防止并发 GC 回收页。
- **append 信任 EventId 计数器** —— `append` 跳过唯一性扫描（系统计数器铸造唯一 id）；`replaceRange` 与 `remove` 会在当前血统内退役被移除的 id，使替换永远无法复用一个仍被旧根（或滚动备份）解析的 id，而直接 `insert` 调用则在入口校验不变量。

- **无真实版本 step** —— `SESSION_FORMAT_VERSION` 仍为 v0，迁移注册表为空。
- **先做单 session 文件** —— 共享 store 后端是后续演进。
- **内容块只校验已知判别** —— `isContentBlock` 对 text/reasoning/tool-call 校验必需字段，其余块类型仅要求字符串 type 标签。
- **blob 不可变校验仅覆盖保留代** —— CAS 更新只在当前代与仍保留的备份之间拒绝 blob 重写；持有某 BlobId 的最后一个备份轮换出局后，同一 id 可携带不同字节，durable 后端须铸造不可复用 blob id 或独立保留已用 blob 指纹。
- **会话元数据字段对齐 SessionHeader** —— parentSession 为 SessionId、origin 为 'subagent'（若存在）；迁移记录从旧头携带这些字段。
- **密集重编号使 seq 基 replace 范围过期** —— `removeEntries` 密集重编号存活条目，压缩前记录的 `shadowedSeqRange` 不再映射重编号后的树；seq 基 replace 范围仅作为审计镜像保留。
- **checkpoint 的 `sourceEventSeqs` 只要求覆盖、不要求精确相等** —— 写入端与导入端都要求 `shadowedSeqs` 中的每个 seq 都被引用，但 checkpoint 还可以引用仍存活的额外更早事件。core 的 `assertProvenance` 同样只做包含性校验，因此超集文件仍可恢复；精确集合相等暂不校验，留待某个生产者证明更紧的溯源后才收紧。
- **需要引用清单** —— 插件 payload 中是序列引用的字段必须先声明，物理压缩才能安全重写。
- **`./btree` 导出面在首个 provider 落地前保持宽** —— 底层原语与节点类型为本包测试与未来持久化 provider 导出；provider 落地后导出面将收窄到其实际 import。可召回压缩提案的反链同样推迟到该工作。
- **引擎模块已重导出，页格式仍走源码树** —— 包入口重导出 `SessionRepository`、`SessionFormatEngine`、`PageStore` 与 `SessionStore`（以及 `BlobStore`/`BLOB_SEGMENT_SIZE`）；页格式与底层模块在 provider 固定其 import 前仍为 `./src/*` 导入。
- **Windows 快照原子但无目录 fsync** —— rename 保持原子，但没有目录 fsync 时，替换在元数据刷盘前可能无法在崩溃后幸存。
- **Windows 替换不保留更窄的受保护 DACL** —— 临时文件继承父目录 DACL，rename 将其带到目标；生产级的 DACL 保留替换路径位于 `dsh-fs-local`。

<a id="dev-note"></a>
### 开发备注

None.
