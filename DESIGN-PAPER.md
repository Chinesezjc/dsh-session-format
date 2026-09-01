# 分离顺序与身份：B+Tree + EventId 会话持久化格式的设计

**DeepSeek Harness session-format 栈（GitHub stack #3200）设计论文**

项目：DeepSeek Harness（`@deepseek-ai/dsh-session-format`，外移仓库 `Chinesezjc/dsh-session-format`）

版本：对应栈 #3178/#3179/#3181/#3183/#3184/#3185/#3188 七层合并视图，含外部仓库磁盘持久化扩展（`DiskPageStore`、`DiskSessionStore`）

日期：2026-09

---

## 摘要

大语言模型智能体的会话日志传统上以追加式事件数组存储，其中 `seq` 同时充当日志的稠密位置与持久身份。这使真正的物理压缩无法实施：删除或合并旧事件需要重编号 `seq`，而重编号会破坏全部引用、使分支点失效并损坏投影状态。本文提出一种将**顺序**与**身份**分离的会话持久化格式：持久化 Copy-on-Write B+Tree 维护事件序列；每个事件持有系统分配的稳定 `EventId`；引用、分支、投影水位与公共 API 一律以 `EventId` 寻址，`seq` 退化为从树推导的稠密排名且不持久化；物理压缩以单个比较并交换（CAS）事务将一段叶子替换为检查点，并将引用重定向至检查点。本文完整描述该格式的七层实现栈——核心类型、操作原型、持久化页面层、分段 blob 存储、原子文件存储、高层仓储与投影水位——以及外移仓库中的磁盘持久化扩展。设计要点包括：带 FNV-1a 校验和的二进制页面容器；页面不可变与 Copy-on-Write 根替换；修订 CAS 与滚动备份（含 ABA 复用防护、事件计数器单调性与事件-内容绑定表单调性）；基于可达性的垃圾回收；单页一节点的多页 B+Tree 持久化；随机临时文件 + fsync + 原子重命名 + POSIX 目录 fsync 的崩溃安全写入协议。验证以每文件 100% 覆盖率为 CI 门禁，主仓库各层合计超过 500 个单元测试用例，外移并加入磁盘持久化后全量 679 个用例通过，关键不变式（ABA 防护跨重建保持、水位兜底、校验和破坏检测）均以负例验证。

**关键词**：会话日志；事件溯源；B+Tree；Copy-on-Write；物理压缩；比较并交换；垃圾回收；大语言模型智能体

---

## 1 引言

DeepSeek Harness 是一个插件化 Cordis 智能体执行框架。智能体的每次交互产生一个会话（session），会话由事件（event）序列构成，事件记录模型请求、工具调用、用户消息与结构化变更。会话日志既是模型上下文的来源，也是推理历史与投影（projection）状态的持久事实源。

现有日志是追加式事件数组：`seq` 既是被追加事件的稠密位置，也被引用、分支、投影和持久化水位用作身份。这个二重角色在会话需要**物理压缩**时成为根本障碍——压缩要求删除或合并旧事件以同时减少磁盘占用与模型上下文，但任何删除都会留下空洞或触发重编号，而重编号使 `seq` 指向的内容发生变化，破坏一切以数字身份建立的持久关系。

本文报告一项格式级重新设计：**顺序与身份分离**。事件序列由持久化 Copy-on-Write B+Tree 维护；每个事件获得永不改变的 `EventId`；所有持久关系改用 `EventId`；物理压缩成为单个原子事务。该设计以七层 PR 栈（GitHub stack #3200：PR #3178/#3179/#3181/#3183/#3184/#3185/#3188）在 `@deepseek-ai/dsh-session-format` 包中实现，随后整体外移至独立仓库 `Chinesezjc/dsh-session-format`，并补充了磁盘持久化层（`DiskPageStore`、`DiskSessionStore`）。

本文结构：第 2 节给出背景与问题定义；第 3 节陈述设计目标与原则；第 4 节概述分层架构；第 5 节描述核心数据模型；第 6 节描述操作层（序列化、压缩、分支、导入导出、迁移）；第 7 节描述持久化层（页面、CAS、GC、多页树）；第 8 节描述高层组装（引擎、仓储、投影、原子文件存储）；第 9 节描述磁盘持久化扩展；第 10 节给出设计权衡与备选方案；第 11 节报告验证方法；第 12 节列出局限与未来工作；第 13 节总结。

## 2 背景与问题

### 2.1 会话日志与 seq 的双重角色

会话日志是追加式事件数组，`seq` 同时承担两个角色：

1. **位置**：事件在日志中的稠密序号，用于排序、分页与增量读取；
2. **身份**：事件在持久层的唯一标识，被引用表、分支边界、投影水位和外部 API 直接使用。

现有持久化后端（JSONL、SQLite）与事件日志机制均以此双重角色为前提：`SessionPersistence.readFrom(fromSeq)` 以 `seq` 寻址，`SessionStore.fork(boundary)` 以 `seq` 为边界，投影水位记录已折叠到的 `seq`。

### 2.2 物理压缩的困境

产品要求会话在磁盘与模型上下文两个维度上都停止为旧事件付费。现有压缩只在模型上下文维度工作：它以 `compaction/summary` 事件替换表面（surface）范围并保留全部旧事件。要获得磁盘收益，必须删除或合并旧事件，而这会：

- 重编号 `seq`，破坏每个以数字身份建立的引用；
- 使既有分支点失效——分支以 `seq` 边界分割树，重编号后边界指向不同内容；
- 损坏投影状态——水位 `seq` 不再对应原事件；
- 使未声明的、载荷内嵌的 `seq` 字段（如插件消息中的引用）指向错误事件。

因此，只要顺序与身份耦合，物理压缩在语义上就不可能正确。

### 2.3 产品目标

- 压缩后的会话在磁盘与重放上停止为旧事件付费；
- 用户可从任意未压缩点分支；
- 未压缩会话与分支点保持 LLM 前缀缓存命中；
- 有损摘要只在不破坏上述缓存规则的前提下可接受。

## 3 设计目标与原则

1. **身份稳定**：事件的持久身份一经分配永不改变，与顺序变更无关。
2. **顺序可重构**：顺序由数据结构推导，删除与插入不要求全局重编号。
3. **事务原子性**：压缩（根替换 + 引用重定向）在单个 CAS 事务内落地。
4. **崩溃安全**：任何时刻的崩溃都留下有效的当前根与可恢复的备份。
5. **损坏可检测**：持久化内容带校验和，损坏必须大声失败而非被解析为错误数据。
6. **引用诚实**：压缩后不存在指向已删除事件的悬挂引用。
7. **单写入者**：并发写入通过 CAS 失败而非静默覆盖。
8. **向后不兼容但向前可迁移**：发布前立场拒绝旧磁盘格式，为未来格式变更保留迁移链机制。

## 4 总体架构：分层栈

格式以七层 PR 栈落地，每层在上一层的界面上叠加，最终合并为一个包：

| 层 | PR | 内容 |
|---|---|---|
| 核心（core） | #3178 | 持久词汇类型、`SessionStorage` 后端缝、内存 Copy-on-Write B+Tree 原型 |
| 操作（operations） | #3179 | 文件序列化、物理压缩事务、分支、导出/导入、遗留迁移 |
| 持久化（persistence） | #3181 | 校验和页面容器、页存储、元数据页、修订 CAS + 滚动备份、GC、多页 B+Tree、端到端引擎 |
| 分段 blob（blob） | #3183 | 2 MB 分段 blob 存储 |
| 原子文件存储（file-store） | #3184 | 崩溃安全原子写与校验和快照容器 |
| 仓储（repository） | #3185 | 高层 `SessionRepository`：读-改-写事务与系统 id 分配 |
| 投影（projection） | #3188 | EventId 投影水位辅助 |

外移仓库在七层之上追加两个磁盘模块：`DiskPageStore`（页面落盘 + 持久化水位）与 `DiskSessionStore`（会话记录落盘 + 持久化 ABA 防护）。

分层边界：核心层只定义词汇与缝，不注册 Cordis 服务；操作层在内存树上证明事务语义；持久化层把树与元数据变为校验和页面；高层组装把事务与 CAS 提供给未来持久化插件的集成面。

## 5 核心数据模型

### 5.1 事件身份：EventId

`EventId = evt_<sessionId>_<counter>`，其中 `counter` 是会话内单调计数器，由系统在追加时分配。计数器高水位 `nextEventCounter` 持久于会话记录，并与根、引用在同一 CAS 中提交，因此重启后的追加绝不会复用被压缩或备份轮换遮蔽过的 EventId。分支子会话对继承事件沿用父会话的 EventId，只对新增事件使用子会话前缀。公共 API 与全部持久引用使用 EventId；`seq` 不暴露。

### 5.2 事件顺序：Copy-on-Write B+Tree

事件序列由 B+Tree 维护，叶子保存 `(EventId, BlobId)` 对（实现中为 `{order, eventId, blobId}` 条目）。树节点不可变，任何变更沿路径复制产生新节点，提交时以单个原子操作切换根。树的稠密排名（rank）即 `seq` 的语义，由树结构推导，不持久化。原型扇出常量（`MAX_ENTRIES = 4`、`MAX_KEYS = 4`）保持分裂路径廉价可测；持久化设计固定 4 KB 页面。

不可变性是三层结构性的：节点对象、节点内数组与条目对象均被冻结，任何持有旧节点的调用方无法原地修改旧树。

### 5.3 载荷寻址：BlobId 与映射表

事件载荷以逻辑 `BlobId` 寻址，经 blob 映射表解析到物理位置 `(segment, offset, length)`。映射表语义类似虚拟内存页表：`BlobId` 是逻辑身份，物理位置变化不改变事件数据。`BlobId` 一旦分配给某段内容永不改变含义（一个 `BlobId` 永远解析到相同字节），这是 GC 与压缩安全性的前提。`SessionRepository` 维护持久化的 `blobIdWatermark` 高水位，保证被压缩丢弃的 id 不会被重新分配给不同字节。

### 5.4 引用表

引用存于独立的引用 B+Tree/表：`(fromEventId, refName) -> toEventId[]`。每条引用记录含源事件、引用名与目标事件数组。引用语义由 `ReferenceRecord` 表保持，压缩事务负责在目标被遮蔽时将其重定向。

### 5.5 会话记录与修订

会话记录（`StoredSessionRecord`）是持久化的 CAS 单元，包含：`sessionId`、`formatVersion`、根页指针、`revision`、`nextEventCounter`、种子边界 `seedBoundaryId`、blob 映射页 / 引用页 / 压缩摘要页指针、`blobIdWatermark`、事件-内容绑定表 `usedEventBindings` 与滚动备份数组。根替换、引用重定向与备份轮换在同一 CAS 事务内落地。修订令牌形如 `rev-<n>`，引擎解析该形式以要求提交严格递增。

## 6 操作层

### 6.1 文件序列化与校验

`file.ts` 提供自包含会话文件的 JSON 序列化，经原子文件存储落盘。序列化边界执行持久性校验：条目按严格递增顺序、EventId 唯一、事件引用的 blob 必须存在、引用源与目标必须存在、压缩摘要的检查点/标记/遮蔽 id 必须满足约束、`nextEventCounter` 必须超过本会话命名空间已用最高编号。校验在建树、写文件与导入三个方向一致，使持久化存储与导出/导入边界共享同一接受集。

### 6.2 物理压缩事务

物理压缩将一段旧表面范围替换为：

```
compaction/start
compaction/summary
user/message checkpoint
compaction/end
```

`compaction/summary` 记录 `shadowedIds`、检查点 EventId 与摘要元数据。

压缩事务的语义（与提案注释的差异已在实现注释中记录）：

- **显式遮蔽集而非连续区间**：`CompactionInput.shadowedIds` 点名被检查点替换的表面事件；其间的日志专用事件（如 `assistant/chunk`、`tool/call` 记录）属于被遮蔽表面节点闭包时一并遮蔽，否则存活。事务按显式 EventId 集合删除，绝不按连续顺序区间删除。
- **标记组不可分割**：前一次事务的 start/summary/checkpoint/end 标记作为一个整体；遮蔽其中任一标记必须遮蔽整个标记组。
- **引用重定向**：存活源事件中被遮蔽的目标重定向至检查点 EventId；源自身被遮蔽的引用行被删除（源已物理消失，悬挂源行比无行更糟）。
- **种子边界重定向**：压缩范围覆盖 `session.seedBoundaryId` 时，检查点成为新种子边界，记录永不指向已删除 EventId。
- **blob 回收时机**：原型实现中，被遮蔽 blob 随事务立即离开文件（自包含文件保持一致）；提案的持久化设计将物理回收推迟到后台 GC。
- **稠密重编号**：压缩后树稠密重编号，`shadowedSeqRange` 等 seq 记录仅供审计镜像，重放与投影层按当前树解释。

压缩以单个 CAS 事务完成：读取当前根与精确修订 → 生成检查点 → 构建移除遮蔽集、插入压缩事件与检查点的新树 → 更新引用表 → 原子提交新根与引用表 → 旧根进入滚动备份。

### 6.3 分支

`forkSessionFile(file, atEventId, childSessionId, record)` 在 `atEventId` **包含边界**处分割：子会话继承父会话前缀（含边界事件本身，边界归属子会话），`atEventId` 之后的事件留在父会话。继承事件保留父 EventId；子会话为全新身份，使用调用方提供的根页与初始修订。blob、引用与压缩摘要仅限继承前缀：引用仅在源与全部目标都继承时保留，压缩摘要仅在检查点事件被继承时保留。子会话的 `seedBoundaryId` 恒为分支边界 `atEventId`，重放与投影不得把继承的父事件当作子会话产生的事件。在任一 `shadowedIds` 中的 EventId 处分叉被拒绝——该区域已被物理压缩。

### 6.4 导出与导入

导出产生自包含归档（会话文件包含树、blob 映射、引用与压缩摘要的全部内容），导入在归档边界执行与写路径相同的校验后恢复会话。引擎的保存/压缩路径执行序列化→反序列化往返，使持久化存储与导出/导入边界共享一个接受集。

### 6.5 迁移

迁移原型只理解遗留 seq 格式版本 0，其余版本拒绝。携带旧格式 `surfaceOp` replace 标记的事件被拒绝（原型迁移器不折叠已替换表面，扁平化会把被遮蔽消息与检查点混入物理序列）；`append` 标记保序可接受。遗留 fork 子会话（`seedLength > 0`）被拒绝——没有父会话的 seq→EventId 映射，继承前缀无法满足分支合约要求的父 EventId。事件信封与 `sourceEventSeqs` 被校验而非静默重写。

发布前立场（`SESSION_FORMAT_VERSION` 保持 0、无兼容承诺）拒绝读取旧磁盘格式，迁移链机制保留给未来格式变更：发布后的一次版本提升可以通过链式迁移前进。

## 7 持久化层

### 7.1 页面容器与校验和

页面容器为二进制格式：`[magic u32 'DSHP'][version u16][pageId 长度 u16][pageId utf8][payload 长度 u32][checksum u32][payload]`。校验和为覆盖 pageId + payload 的 FNV-1a 32 位值，任何损坏在页面使用前被检测。解码执行完整校验：魔数、版本、长度一致性、UTF-8 严格解码与校验和比对，任何失败抛出异常而非返回部分数据。

### 7.2 页存储

`PageStore` 以 `page_<n>` 形式的单调递增 id 寻址页面，读取时逐页验证 id 与校验和并返回防御性副本。id 单调源为进程内计数器；重新在既有存储上打开时越过既有最大 `page_<n>` 续接，绝不回落到已被 GC 回收的 id。存储映射可注入，使测试能通过真实读取路径模拟存储层损坏。

### 7.3 元数据页

blob 映射、引用表与压缩摘要各自序列化为独立校验和页面：`saveBlobMap/loadBlobMap`（base64 载荷）、`saveReferences/loadReferences`、`saveCompactionSummaries/loadCompactionSummaries`。blob 映射页在会话记录中以 `blobMapPage` 指针引用，压缩摘要页以 `compactedPage` 引用。

### 7.4 多页 B+Tree

`multi-page.ts` 将 B+Tree 每个节点序列化为独立校验和页面，内部节点以 PageId 引用子页面。加载执行结构校验：展平条目严格递增且 EventId 唯一、内部节点非空、子树高度一致。空树序列化为空叶子页。该层把第 5.2 节的内存树映射到持久化页面寻址，是根指针、GC 可达性与 CAS 提交的对象。

### 7.5 修订 CAS 与滚动备份

`SessionStore.commit` 是会话记录的唯一变更路径，满足以下全部条件才接受替换：

1. 会话 id 匹配且记录存在；
2. `expectedRevision` 等于当前修订；
3. 新修订必须**推进**（接受不变令牌会让陈旧快照再次覆盖新状态）；
4. 新修订不得是任何已用修订——`usedRevisions` 集合拒绝 A→B→A 的 ABA 复用；
5. `nextEventCounter` 为安全整数且不低于当前值（单调高水位）；
6. 事件-内容绑定表 `usedEventBindings` 单调：当前表的每条绑定必须原样存活到新表，提交不得把已退休 EventId 重新绑定到不同内容——即使持有该绑定的所有备份都已轮换出去。

成功提交把完整前代（全部页面指针）追加进滚动备份，按配置上限（默认 3 代）一次性裁剪；本存储是备份簿记的唯一所有者。修订由后端铸造，提交携带的修订只是占位符，绝不复用。

### 7.6 垃圾回收

`collectGarbage` 以可达性为判据：页面从会话记录指针（树根、blob 映射页、引用页、压缩摘要页）与全部保留备份的页面指针出发，经多页树内部子引用递归可达者保留，其余删除。遍历对结构损坏保守失败：可达页面若携带非法 JSON 或声明未知 `kind`，GC 中止而非冒险删除其可能引用的页面——宁可停止回收，不可静默丢失可恢复数据。

## 8 高层组装

### 8.1 SessionFormatEngine

引擎把树持久化、blob/引用/摘要页面、压缩、分支、CAS 与 GC 组装为端到端操作：`saveSession`/`loadSession` 以序列化→反序列化往返发布文件；`compact` 与仓储追加共用 `commitSession` 这一单一提交路径（压缩也经 CAS 提交）；解析 `rev-<n>` 要求提交严格推进。发布前执行 `validateSessionFile` 全量关系校验。

### 8.2 SessionRepository

仓储是未来 Cordis 持久化插件包裹的高层集成面，拥有引擎之上的读-改-写事务：

- **append**：加载当前文件 → 铸造下一个 `EventId`（`nextEventCounter` 铸为后缀，首个铸造 id 等于计数器，提交后推进；同时越过文件中出现的每个更大计数与每条压缩摘要记录的遮蔽 id）→ 铸造下一个 `BlobId`（高于持久化水位与映射表中全部数值 id）→ 推进修订 → 经 `engine.commitSession` 的 CAS 发布新根。并发写入使 CAS 返回失败而非静默覆盖，调用方重载重试。
- **createSession**：接受无根页的 `NewSessionFile`，根页由引擎在注册时分配；拒绝已注册的会话 id。
- **compact**：从当前记录推导下一修订，不信任调用方令牌。

blob 载荷的唯一权威是会话文件 blob 映射（引擎持久化、`loadSession` 读回）；仓储不注入 `BlobStore`、不暴露 `readBlob`。

### 8.3 投影水位

投影把会话事件折叠为派生状态并记录已折叠到的 EventId：

- `ProjectionState<T> = { value, watermarkEventId }`；
- `advanceProjection` 在同一操作内折叠事件并推进水位（折叠必须是纯函数；调用方按流顺序从首个事件折叠）；
- `projectionWatermarkShadowed` 做窄检查：水位恰是被遮蔽 id 之一；
- `projectionNeedsRebuild` 做宽检查：水位是被遮蔽 id，或水位在树中排名不低于检查点事件——排名来自树，因为 EventId 计数器是分配序而非流序，压缩把替换 id 插入旧位置，计数器不能给事件排序。

水位或检查点不在当前树中时（更晚的压缩已重排流），检查报告陈旧——宁可多余重建，不可复用陈旧状态。

### 8.4 原子文件存储

`file-store.ts` 拥有快照容器并把写协议委托给共享零依赖工具 `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomicDurable`：写入随机同目录临时文件（`.${uuid}.tmp`，`wx` 排他创建 + 模式 `0600`）→ fsync → 原子重命名覆盖目标 → POSIX 上 fsync 父目录使替换崩溃安全；任何失败删除临时文件并重抛。随机名使并发写入者位于不同 inode，重命名不会发布撕裂的临时文件；`wx` 拒绝跟随植于临时路径的符号链接；`0600` 在宽松 umask 下保持快照私有。Windows 无法对目录执行 `sync()`，故跳过目录 fsync（重命名本身在 Windows 上仍原子），并对 `EACCES`/`EBUSY`/`EPERM` 干扰以有界退避重试。

快照容器复用页面容器：固定页 id `snapshot`，`decodeSnapshot` 拒绝任何其他页 id。`file.ts` 的 `writeSessionFile`/`readSessionFile` 经由该存储持久化，使会话文件获得同一套损坏检测。

## 9 磁盘持久化（外移仓库扩展）

外移仓库在内存页存储与内存会话存储之上补全磁盘实现，`SessionFormatEngine` 可无缝切换（接口一致）：

### 9.1 DiskPageStore

每页一个带校验和的页文件（`<root>/pages/page_<n>.page`，复用 `encodePage`/`decodePage`）；水位持久化在 `<root>/meta.json`。重建时取 `max(meta 水位, 扫描页面文件最大 id + 1)` 兜底崩溃窗口——崩溃可能使 meta 落后于已落盘页面；删页不降水位，GC 后 id 不复用。内含同步版原子写 `writeFileAtomicDurableSync`（temp + fsync + rename + 目录 fsync，Windows rename 重试）。

### 9.2 DiskSessionStore

每会话一个 JSON 记录文件（`<root>/records/<sessionId>.json`），记录与 `usedRevisions` ABA 集合一次原子 fsync 写入——旧限制"ABA 防护仅存内存"被消除。构造时扫描 records/ 重建全部记录与 used-set。损坏、缺失字段或重复会话被拒绝。接口与 `SessionStore` 一致（putSession/getSession/sessions/commit）。全磁盘引擎重启测试验证：同目录重建后 `loadSession` 按 id 恢复完整树与 blob。

## 10 设计权衡与备选方案

| 决策 | 采用方案 | 被否决的备选 | 否决理由 |
|---|---|---|---|
| 持久身份 | EventId（分配即恒定） | 保留 seq 作身份并重映射引用 | 每次物理压缩需全局引用重映射，易漏插件载荷中未声明的数值 seq 字段，分支语义脆弱 |
| 存储布局 | 每会话一个自包含文件 | 自始共享对象存储 | 共享存储利于分支共享与去重，但单会话导出困难、单个损坏共享页影响多会话；每会话文件保持损坏隔离，后端缝保留日后迁移空间 |
| 损坏检测 | 页级校验和 + 滚动备份 | Git 式内容寻址页面 | 内容哈希带来强检测与自然去重，但增加对象存储复杂度且与逻辑 BlobId 映射交互；页级校验和覆盖当前完整性需求 |
| 压缩形态 | 物理压缩（重写持久日志） | 保持追加式压缩（摘要 + 表面替换） | 现有压缩只减模型上下文、从不删磁盘；物理压缩是其超集，沿用同一摘要算法，不取代既有压缩缝 |
| 遮蔽语义 | 显式 EventId 集合 | 连续顺序区间 | 表面遮蔽按表面序选择，不是连续日志区间；区间删除会误伤交错的存活结构事件 |
| 遮蔽源引用 | 删除该行 | 重定向至检查点（如目标） | 源已物理消失不能拥有引用；并入检查点会错误归因摘要内容；删行保持表诚实 |
| blob 权威 | 会话文件 blob 映射唯一权威 | BlobStore 为唯一权威、文件只存 id | BlobStore 是独立测试的原型；改作权威需同变更重构 file/metadata/fork/migrate/compaction；保持单一权威且改动最小 |
| 追加事务位置 | SessionRepository | 折入 SessionFormatEngine | 引擎保持低层缝，事务契约集中在插件预期的集成面 |
| EventId 分配 | 系统分配 | 调用方分配 | 调用方分配可致两个追加复用同一 id，树只保留最后位置，rank/分支/压缩解析错误事件 |
| 原子写临时文件 | 随机 `wx` + 0600 兄弟文件 | 固定 `${path}.tmp` + `'w'` | 固定路径可被 `'w'` 跟随符号链接，并发写入者共享单 inode，一方的重命名可能发布另一方的撕裂临时文件 |
| 快照容器 | 复用页面容器（固定页 id） | 独立快照头（magic/version/length/checksum） | 快照本就是固定 id 的页；复用消除包内第三套手写容器格式 |
| 目录 fsync | 仅 POSIX | 无条件 | 无条件时 Windows 每次成功重命名后抛错，调用方重试已提交的写入 |
| 写协议归属 | 共享 `dsh-atomic-write` 单一实现 | 第二份私有副本 | 重复 storage-json 原子写器体会触发复制检测门禁 |

## 11 正确性与验证

验证以"断言必须能失败"为原则，覆盖每个分支，并在缺陷的最终形态上构造负例：

- **门禁**：CI 覆盖率门禁要求包内每文件 100% 覆盖（`test:coverage`），外加 typecheck、lint、复制检测（0 克隆）、`verify-export-jsdoc` 与文档/翻译配对门禁。分支相关门禁：`verify-package-invariants` 要求空不变式伴随体一律省略。
- **用例规模**：主仓库各层 PR 合计超过 500 个单元测试用例（operations 层 504、persistence 层累计约 530 个 session-format 用例）；外移并加入磁盘持久化后，外部仓库全量 679 个用例通过，tsc 干净。
- **负例验证**（各层均有注入缺陷→确认变红→还原的闭环）：破坏 used-set 重建恢复使 ABA 测试变红；破坏 `putSession` 写盘使 7 个测试变红；水位兜底负例（meta 水位落后于页面文件、删页不降水位）；校验和破坏负例（解码必须拒绝）；存储级损坏注入经真实读取路径验证。
- **端到端**：引擎 save/load 端到端、树跨重建读回、全磁盘引擎重启（`DiskPageStore` + `DiskSessionStore` 同目录重建后按 id 恢复完整树 + blob）、POSIX 并发写入者、导出/导入往返、分支继承约束、压缩标记组完整性、引用重定向与删除。
- **真实 API 门禁**：包不注册 Cordis 服务、无模型可见内容，因此按约定不含模型/用户输出快照；行为契约以单元级负例与 CI 静态门禁承载。

## 12 局限与未来工作

- **原型尺寸**：B+Tree 扇出常量（4/4）与 2 MB blob 段、1 GB 文件段为原型值；持久化设计固定 4 KB 页面，尚未落地为最终文件布局。
- **线性追加**：`append` 扫描事件列表与 blob 映射以推进计数器与水位，每次提交重读当前 blob 映射与全部滚动备份的映射验证不可变性，追加无界会话为 O(n)；持久化计数器或索引被推迟。
- **低层提交点信任调用方**：直接 `engine.commitSession`/`engine.compact` 可提供降低的 blob 水位或上限修订；仓储路径总是推导递增值，未来可在提交点强制两者。
- **存储契约仅 JSDoc**：页/blob 不可变性、只创建写入与 CAS 铸造修订是接口契约，尚无后端实现，也没有钉住页面防止并发 GC 的修订绑定读句柄。
- **blob 不可变性按保留代检查**：CAS 更新只对当前代与仍保留的备份拒绝 blob 重写；持有某 BlobId 的最后一个备份轮换后，同一 id 可能携带不同字节，持久后端必须铸造不可复用 blob id 或自持 used-blob 指纹。
- **seq 引用清单**：插件载荷中未声明的序列引用字段必须在物理压缩安全改写前声明。
- **Windows 快照**：原子但无目录 fsync；替换不保留既有快照更窄的保护 DACL（生产路径在 `dsh-fs-local`）。
- **下一块**：`SessionRepository` 层切换到磁盘存储、`file-store.ts` 快照容器接线，或 blob 持久化（`BlobStore` 磁盘版，含 blob 不可变跨代限制）。
- **recallable compaction 协调**：提案要求 `history_read` 从日志返回任何被遮蔽原始内容，与物理 GC 矛盾；两者都实现后再协调。

## 13 结论

本文报告了 B+Tree + EventId 会话持久化格式的完整设计。核心洞见是把顺序与身份分离：事件序列由 Copy-on-Write B+Tree 维护，身份由系统分配的稳定 EventId 承担，`seq` 退化为推导排名。这一分离使物理压缩成为语义正确的单 CAS 事务，同时保持分支、引用、投影与导出/导入的全部既有合约。七层实现栈以校验和页面、修订 CAS 与 ABA 防护、可达性 GC、原子文件存储与投影水位等机制把设计落地为可验证的代码，外移仓库进一步补全了磁盘持久化。该格式在发布前立场下不接受旧磁盘格式，但保留迁移链机制，为发布后的版本演进留出通道。

## 参考文献

1. DeepSeek Harness，Agent Note：*Session physical compaction with B+Tree and EventId pointers*（proposed），`.agents/notes/proposed/architecture/2026-08-26-session-physical-compaction-btree-pointer.md`（中译：`...zh.md`）。
2. DeepSeek Harness，Agent Note：*Session repository owns read-modify-write transactions*（implemented），`.agents/notes/implemented/architecture/2026-08-26-session-repository-layering.md`。
3. DeepSeek Harness，Agent Note：*Session format operations prototype scope and deviations*（implemented），`.agents/notes/implemented/architecture/2026-08-27-session-format-operations-prototype.md`。
4. DeepSeek Harness，Agent Note：*Durable atomic snapshot file store*（implemented），`.agents/notes/implemented/architecture/2026-08-27-session-format-durable-atomic-file-store.md`。
5. DeepSeek Harness，Issue #2692：*建立 Session format migration 解码链与原子写回机制*。
6. DeepSeek Harness，PR 栈 #3200（GitHub stack）：#3178 `feat(session-format): core B+Tree and EventId session format`、#3179 `feat(session-format): file serialization, compaction, fork, export/import, and migration`、#3181 `feat(session-format): durable pages, CAS, GC, engine, and multi-page tree`、#3183 `feat(session-format): add segmented blob store`、#3184 `feat(session-format): add durable atomic file store with checksums`、#3185 `feat(session-format): add high-level session repository`、#3188 `feat(session-format): add EventId projection watermark helpers`。
7. DeepSeek Harness，`@deepseek-ai/dsh-session-format` 包 README（`packages/session/session-format/README.md`，中译 `README.zh.md`）。
8. DeepSeek Harness，*Session Persistence*，`docs/subsystems/persistence.md`。
9. DeepSeek Harness，Agent Note：*Session log version mechanism*（implemented），`.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md`。
10. DeepSeek Harness，Agent Note：*Recallable compaction*（proposed），`.agents/notes/proposed/feature/2026-07-06-recallable-compaction.md`。
11. 外移仓库 `Chinesezjc/dsh-session-format`（https://github.com/Chinesezjc/dsh-session-format），含 `src/disk-page-store.ts`、`src/disk-session-store.ts`、`src/event-id.ts`、`src/atomic-write.ts` 适配层与 `tools/dsh-session-format-sync/` 同步插件。
