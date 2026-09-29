# JSON 契约工坊（JSON Contract Studio）

把零散的 JSON 样本整理成接口契约：粘贴多份 JSON，系统递归归纳出 **JSON Schema 2020-12**，
自动处理字段缺失、`null`、异构数组与类型冲突，并在树形视图中标注每条规则对应的样本路径；
支持一键复制 Schema、校验新样本并按 **JSON Pointer** 展示错误；
还可在校验页粘贴最多 200 条待检样本做**错误热点**分析——服务端用 Ajv 逐条校验，
按规则路径（schemaPath）与关键字把错误聚簇（数组下标差异归并、required/additionalProperties
按字段分簇），按受影响样本数降序定位最痛的契约违规点；
用**样本贡献度**分析逐条评估样本对契约的影响（关键/冗余，附受影响的规则 Pointer）；
还可把归纳结果设为基线，对比新旧两版 Schema 的**契约演进**（破坏性/兼容判定），
为每条破坏性变更加载**反例样本**（递归构造最小 JSON 并用 Ajv 双侧校验），
用**样本影响扫描**把历史样本集按基线/当前 Schema 逐条校验并归类（两版均通过、仅基线通过、
仅当前通过、两版均失败），
在演进页配置「源 JSON Pointer → 目标 JSON Pointer」映射（可带默认值）做**历史样本迁移**——
后端先按路径深度规划操作，再对每条样本原子执行移动/补值，正确处理数组元素（各层下标按迁移前
位置定位，源删除留空位、全部写入完成后统一压缩，未移动元素不丢失）、父子路径重叠与目标冲突，
冲突样本保持原样并说明原因，迁移后用 Ajv 校验当前 Schema，可展开前后对比并仅复制成功结果；
通过**发布门禁**结合基线/目标 SemVer 给出允许或阻止发布的结论与可复制报告，
并可按**判别字段**把样本分组生成**事件变体契约**（每组复用归纳引擎生成一个 `oneOf` 分支，
分支内判别字段固定为对应 `const`）；
还可配置多条 **JSON Pointer 规则**对样本做**匿名化导出**——命中标量被替换为跨样本稳定、
保留 JSON 类型的假名，先预览各规则命中情况再一键复制；
也可在 Schema 树勾选 1～20 个节点生成**契约切片**——仅保留所选节点及必要祖先结构的独立
Schema，并同步投影当前样本（后端用 Ajv 逐条校验投影，任一失败则不产出）；
还可做**字段关系挖掘**——在每个对象 Pointer 作用域内统计字段出现集合（数组元素按元素独立计数、
不跨作用域关联），找出支持数 ≥ 2、置信度 100% 的「出现 A 必出现 B」与「A/B 互斥」候选（蕴含做
传递约简），勾选后生成加入 `dependentRequired`、`not/required` 组合的增强 Schema（全部原样本经
Ajv 复验通过才产出）。

技术栈：Node.js · Express · React（Vite）· Ajv（draft 2020-12）

## 快速开始（Docker，单条命令）

```bash
docker compose up --build
```

启动后访问：**http://localhost:8080**（Web 界面与 API 同端口，API 前缀 `/api`，
如 `POST http://localhost:8080/api/infer`、`POST http://localhost:8080/api/hotspots`）。

**必要配置**：无需任何额外配置或外部依赖（镜像内已完成依赖安装、前端构建与后端启动）。
唯一可配置项是环境变量 `PORT`（默认 `8080`，见 `docker-compose.yml`）；如修改端口，
需同步调整 compose 的端口映射（`"宿主端口:容器端口"`）。

> 依赖安装、前端构建、后端运行全部包含在该命令内，无需任何本地环境（除 Docker）。
> 不使用 Compose 时亦可：`docker build -t json-contract-studio . && docker run -p 8080:8080 json-contract-studio`

停止：`docker compose down`。

| 项目 | 值 |
| --- | --- |
| 启动命令 | `docker compose up --build`（停止：`docker compose down`） |
| 访问地址 | http://localhost:8080 |
| API 前缀 | `/api`（与 Web 界面同端口，如 `/api/validate`、`/api/hotspots`） |
| 可选配置 | 环境变量 `PORT`（默认 `8080`，需同步调整 compose 端口映射） |
| 本地开发 | `npm run setup` 后分别 `npm run dev:server`（8080）与 `npm run dev:client`（5173），见「本地开发」 |

## 功能与归纳规则

| 场景 | 归纳结果 |
| --- | --- |
| 字段在部分样本中缺失 | 该字段不进入 `required`（即可选） |
| 字段出现 `null` | `type` 变为联合类型，如 `["null", "string"]` |
| 整数与浮点混排 | 放宽为 `"number"` |
| 异构数组（如 `["a", 1, null]`） | 所有元素折叠为单个 `items`，类型取并集 |
| 对象与标量冲突 | `type` 并集，如 `["string", "object"]`，`properties` 仅约束对象实例 |
| 全为空数组 | 不生成 `items` 约束（任何元素均可） |

- **树形视图**：每个节点显示类型徽章、必填/可选/可空/多类型标记；点击「n 处样本」展开
  贡献该规则的样本路径（`#/<样本序号>/<路径>`，RFC 6901 转义）。
- **复制 Schema**：一键复制完整 Schema JSON 到剪贴板。
- **校验新样本**：基于 Ajv（`allErrors`），错误按 JSON Pointer（如 `/tags/0`）展示，
  并附带关键字、信息与对应规则路径。结果与**提交时的样本文本和校验契约**绑定：修改待检 JSON、
  重新归纳 Schema 或切换归纳/变体契约后，旧结果与旧错误立即清空；请求尚未返回时发生上述变更，
  过期请求的成功或失败响应都会被忽略，不会回填，界面只展示匹配当前输入与契约的最近一次结果。
- **错误热点**：在「③ 校验新样本」页粘贴一个 JSON 数组作为待检样本集（最多 200 条），
  服务端用当前校验目标（归纳 Schema 或事件变体契约）逐条校验，把 Ajv 错误按
  **schemaPath + keyword** 聚簇——同一规则在不同数组下标的报错归为一簇，但 `required`
  按 `missingProperty`、`additionalProperties` 按 `additionalProperty` 分簇；每簇给出
  受影响样本数、错误次数、样本索引与原始实例 Pointer，按受影响样本数降序展示、可展开详情；
  修改待检样本、重新归纳 Schema 或切换校验目标后，旧聚簇结果与错误立即清空，进行中的旧请求
  响应也会被忽略，只保留匹配当前输入与契约的最近一次分析。
- **样本贡献度**：在「① 样本输入」区一键做留一法分析——后端按**样本索引**把每个 Schema 节点的
  类型贡献、字段出现次数与数组元素证据汇总成单份证据树（单次遍历；数组中的多个对象/元素分别
  计数，空数组不产生 `items` 证据）；逐条**扣除**一条样本贡献的类型、字段出现次数和数组元素
  证据即可算出移除后的规则（类型收窄、字段消失、必填翻转、`items` 消失），判定每条样本为
  **关键**（移除后规则变化）或**冗余**（移除后规则完全一致），并列出受影响的 JSON Pointer；
  结果区展示关键/冗余数量，可按类型筛选、展开受影响规则，并一键定位到原始样本。单次最多 50 条。
- **契约演进对比**：把当前归纳结果设为基线，修改样本后归纳新版 Schema，比较器递归处理
  对象属性、`required`、类型联合与数组 `items`，在结果区按 JSON Pointer 分组展示变更清单；
  每条变更给出旧/新规则与判定原因，可一键筛选破坏性项。
- **破坏性反例生成**：每条**破坏性**变更可展开「生成反例」。后端依据新旧 Schema、当前视角与
  变更 JSON Pointer 递归构造**最小 JSON**——请求体视角须「旧版通过、新版拒绝」，响应体视角须
  「新版通过、旧版拒绝」；沿途的必填兄弟字段自动填入可通过校验的占位值。覆盖新增/取消必填、
  类型收窄/放宽、数组 `items` 新增/移除。构造后用 Ajv 同时校验两侧，仅在方向确实成立时返回
  样本与双侧错误；若变更被 `enum` 等其他约束抵消而无法构造，则返回明确的不可构造原因。
  展开后可查看格式化样本、双侧校验结论与 Ajv 错误（Pointer/关键字/规则路径/参数），并一键复制样本。
- **样本影响扫描**：在演进页粘贴一个 JSON 数组作为历史样本集，后端用 Ajv 把每条样本分别按
  **基线**与**当前** Schema 校验，归类为「两版均通过 / 仅基线通过 / 仅当前通过 / 两版均失败」；
  结果区按类展示数量与样本索引（`#0`、`#1`…），展开单条可查看两侧错误的 JSON Pointer、关键字与信息。
  单次最多 200 条，超限或输入非数组时前后端都会给出明确错误。
- **历史样本迁移**：在演进页粘贴一个 JSON 数组作为旧样本集（最多 200 条），并配置若干
  「源 JSON Pointer → 目标 JSON Pointer」映射，每条映射可选一个 JSON 默认值。后端先按
  **路径深度规划全局操作**（源移除由深到浅、目标写入由浅到深），再对每条样本**原子执行**：
  源位置存在则**移动**（RFC 6901 转义），源缺失则按默认值**补值**；
  支持父子源路径重叠（深路径先摘出再移动祖先子树）、交换（`/a→/b` 与 `/b→/a`）、
  链路（`/a→/b`、`/b→/c`）、数组元素移动与末段 `-` 末尾追加、缺失中间容器按数组/对象自动创建。
  **数组各层下标始终按迁移前的元素位置定位**：源删除在数组中留下空位（不即时挤压），
  全部目标写入完成后统一递归压缩空位，被目标重新填入的空位保留——因此数组元素双向交换
  （如 `/arr/0↔/arr/1`）不会让未移动的元素丢失或被错写，嵌套数组与「移出后再写回原数组
  其他位置」的组合同样成立，且结果与映射填写顺序无关。
  目标已存在且未被生效的源移动覆盖、两个写入落到同一位置、目标路径穿过标量、数组下标非法或
  越界等情况会让**整条样本回滚保持原样**并逐条列出冲突原因。迁移完成后用 Ajv 按**当前 Schema**
  校验，界面按**成功 / 冲突 / 校验失败**三类汇总（另对原样本附基线 Schema 校验结论），
  每条可展开迁移前后对比、逐映射动作（移动/补值/跳过）与 Ajv 错误，并可**仅复制成功结果**数组。
  映射配置本身非法（非法 Pointer、目标为根、源目标相同、源重复、目标父子重叠、`-` 不在末段）
  时整批拒绝（422）并按映射序号列出原因，不触碰任何样本。
- **发布门禁**：在演进页填写基线版本（当前 SemVer）与目标版本（新版 SemVer），门禁复用当前
  `/api/diff` 差异汇总即时给出「允许/阻止发布」结论，展示实际升级类型、触发结论的变更数量与
  原因，并可复制包含版本、视角、汇总与结论的 JSON 报告；切换视角或修改版本号都会即时重算。
- **事件变体契约**：在「⑤ 事件变体」页填写判别字段的 JSON Pointer（如 `/type`），系统读取每条
  样本该位置的字符串/数字/布尔值并按值分组，每组复用归纳引擎生成一个分支，最终合并为带 `oneOf`
  的 JSON Schema；每个分支把判别字段约束为对应 `const`，且仅组内共同存在的字段进入 `required`。
  判别字段缺失、值为对象/数组/null 或 Pointer 转义非法的样本不参与生成，并按样本序号列出原因；
  有效分组不足 2 个时拒绝产出。结果区展示分组数量、样本数与各分支 Schema，可一键复制完整契约，
  并可一键接入「③ 校验新样本」验证新样本。
- **匿名化导出**：在「① 样本输入」区配置多条 JSON Pointer 规则（支持 RFC 6901 转义与单段 `*`
  通配对象键或数组下标），后端递归匹配最多 200 条样本，把命中的标量替换为跨样本稳定、保留
  JSON 类型的假名（同一规则下相同原值映射一致、不同原值不合并、整数不变小数）；界面先展示
  各规则命中数、未命中项与错误，确认后再一键复制匿名化样本。非法 Pointer、命中对象/数组，
  或不同规则命中同一路径时拒绝生成。
- **契约切片**：在「⑥ 契约切片」页的 Schema 树勾选 1～20 个节点，生成仅保留所选节点及必要
  祖先结构的独立 Schema，并同步投影当前样本；祖先已选时其子项自动包含（重复/被覆盖的勾选
  会被忽略并标注）。界面预览字段数与样本数，可分别复制切片 Schema 与投影样本；后端用 Ajv
  逐条校验投影样本，任一失败则不产出并返回样本索引与错误。

## 契约演进：操作说明

1. 粘贴样本并点击「归纳 Schema」，在「② 契约 Schema」页点「设为基线」（或到「④ 契约演进」页设置）。
2. 修改左侧样本，再次点击「归纳 Schema」，结果区自动切到「④ 契约演进」并展示与基线的差异。
3. 选择视角、按需勾选「仅显示破坏性变更」；可随时「将当前结果设为基线」或「清除基线」。
4. 在每条**破坏性**变更下点击「生成反例」：展开后查看最小反例样本（可一键复制）与旧/新两版
   Ajv 校验结果；无法构造时会展示具体原因（如该节点的唯一区分取值被 `enum` 等约束禁止）。
5. 在「样本影响扫描」卡片粘贴历史样本的 JSON 数组并点击「开始扫描」：结果按四类分组展示
   数量与样本索引，点击单条样本可展开基线/当前两侧的 Ajv 校验详情（Pointer、关键字、信息）。
6. 在「发布门禁」卡片填写基线版本与目标版本（SemVer），即时得到放行结论，需要时可复制门禁报告。
7. 在「历史样本迁移」卡片粘贴旧样本 JSON 数组，添加若干「源 → 目标」映射（可选 JSON 默认值）
   后点击「开始迁移」：结果按成功 / 冲突 / 校验失败汇总，点击单条可展开迁移前后对比、
   逐映射动作与 Ajv 错误；「仅复制成功结果」只复制通过当前 Schema 校验的样本数组。

基线仅保存在当前浏览器会话（`sessionStorage`）：刷新页面仍在，关闭标签页即失效，不会上传到服务器持久化。
门禁填写的两个版本号同样仅保存在当前浏览器会话。

判定规则（其余变更标为「兼容」或「提示」）：

| 视角 | 破坏性变更 | 示例 |
| --- | --- | --- |
| 请求体（客户端 → 服务端） | 新版新增必填字段；收窄可接受类型 | 可选变必填、`["null","string"]` → `"string"` |
| 响应体（服务端 → 客户端） | 新版删除必填输出；放宽输出类型 | 必填字段被移除、`"integer"` → `"number"` |

## 样本贡献度：判定规则

分析在 **http://localhost:8080** 页面的「① 样本输入 → 样本贡献度分析」区进行（点击
「分析样本贡献度」），也可直接调用 `POST /api/contribution`。语义上等价于留一法：对每条样本
都求「移除它后剩余样本归纳出的 Schema」，再与完整样本集的规则比较；但实现上**不会逐条重新
归纳、重复遍历同一批数据**，而是一次遍历后按**样本索引**汇总证据：

| 判定 | 含义 |
| --- | --- |
| 关键（`critical`） | 移除该样本后，至少一条规则发生变化（类型联合、必填集合、字段有无、数组 `items` 约束） |
| 冗余（`redundant`） | 移除该样本后，归纳出的规则与完整样本集完全一致 |

- **按样本索引汇总的证据**：每个 Schema 节点记录——各类型分别由哪些样本贡献（整数/小数按归纳
  引擎规则归并：一旦有小数，整数被并入 `number`）；各样本在该节点放置的**对象实例数**；每个
  字段的**逐样本出现次数**（必填 = 出现次数等于对象实例总数）；以及各样本推入 `items` 的
  **数组元素数**。同一样本在数组中的**多个对象/元素分别计数**；**空数组贡献零个元素，不产生
  `items` 约束**（移除它因此永远无差异）。求某条样本的移除结果时，只需从汇总计数中扣除该样本
  的贡献：某类型无其他样本贡献即类型收窄（小数消失时整数重新成立）、字段出现次数归零即字段
  消失、出现次数与剩余对象数相等即必填翻转、元素数归零即 `items` 消失——判定只与计数和集合
  有关，不再随样本数重复遍历输入。
- **准确的规则 Pointer**：比较覆盖归纳引擎的全部规则词表——唯一字段消失、必填翻转、整数/小数
  类型收窄、数组 `items`（含嵌套 `items`）消失或收窄——都返回发生变化的节点 Pointer；字段子树
  整体消失时只报其根指针（不下钻），嵌套数组对象内的字段仍给出完整嵌套 Pointer，同一节点多处
  变化只计一次。
- **无伪差异**：判定只依赖类型集合与计数是否相等，与样本的**对象键顺序**、**数组元素顺序**
  无关，二者不会产生伪差异；受影响的规则按 Schema JSON Pointer 列出（根节点显示为 `(root)`）。
- **结果展示**：汇总关键/冗余数量，可按「全部 / 仅关键 / 仅冗余」筛选；展开单条样本可查看
  受影响的规则 Pointer 列表，点击「定位样本」滚动并高亮对应的原始样本编辑器。
- **失效**：任何样本内容修改都会使上一次分析结果立即失效（结果区清空并提示重新分析）。
- **限制**：单次最多分析 **50** 条样本；超限时前端在提交前拦截提示，接口也返回 `400`
  及明确错误信息。样本存在无效 JSON 时分析按钮不可用。

## 错误热点：聚簇规则

入口：**http://localhost:8080** 页面的「③ 校验新样本 → 错误热点」区（需先归纳出
Schema，或生成事件变体契约并切换校验目标），也可直接调用 `POST /api/hotspots`。
粘贴一个 JSON 数组作为待检样本集（每个元素为一条样本，单次最多 **200** 条），服务端用
Ajv（`allErrors`）把每条样本对当前校验目标逐条校验，再把全部错误按**产生它的规则**聚簇：

| 维度 | 规则 |
| --- | --- |
| 聚簇主键 | Ajv 错误的 `schemaPath` + `keyword`（同一规则即同一簇） |
| 数组下标归并 | 同一 `items` 规则在 `/tags/0`、`/tags/1` 等不同下标的报错归为一簇 |
| `required` 分簇 | 按 `params.missingProperty` 分簇——缺少不同必填字段是不同热点 |
| `additionalProperties` 分簇 | 按 `params.additionalProperty` 分簇——不同的多余字段是不同热点 |

- 每簇展示：**受影响样本数**、**错误次数**、样本索引（`#0`、`#1`…）与每条错误的
  **原始实例 Pointer**（根节点显示为 `(root)`）、Ajv 信息与参数；簇列表按**受影响样本数
  降序**排列（相同则按错误次数），点击簇头展开/收起详情。
- 汇总区给出样本总数、通过/失败数、错误总数与簇数；全部通过时明确提示没有错误热点。
- 输入非 JSON 数组或超过 200 条时前端在提交前拦截，接口同样返回 `400` 及明确错误信息；
  Schema 无法编译返回 `422`。
- 修改待检样本、重新归纳 Schema 或切换校验目标后，旧聚簇结果与错误立即清空；分析请求
  尚未返回时变更输入或契约，过期响应（无论成功或失败）一律忽略，仅展示匹配当前输入与
  契约的最近一次结果，需重新分析。

## 反例构造：规则与判定方向

反例针对单条破坏性变更，目标是「只被这一处差异绊倒」的最小文档：

| 变更类型 | 构造动作 |
| --- | --- |
| 新增必填 / 新增必填字段（请求视角） | 父对象省略该字段，其余必填兄弟字段填占位值 |
| 取消必填 / 删除必填字段（响应视角） | 新版文档省略该字段（旧版必填校验据此失败） |
| 类型收窄（请求）/ 放宽（响应） | 在目标节点取一个「一侧接受、另一侧拒绝」的类型占位值 |
| 数组 `items` 新增约束（请求）/ 移除约束（响应） | 数组放恰好一个具有区分类型的元素 |

- 必填兄弟字段的占位值取满足**接受侧**约束的最小值（优先同时满足另一侧）：
  标量为 `null`/`false`/`0`/`0.5`/`""`，对象递归补齐必填键，数组从空开始。
- 构造完成后用 Ajv 对同一份文档校验两侧；只有方向成立
  （请求：旧✓新✗；响应：新✓旧✗）才返回 `sample` 与 `oldResult/newResult`，
  否则返回 `{ "constructible": false, "reason" }`，说明是接受侧未通过还是两侧都接受。

## 样本影响扫描：归类规则

扫描在 **http://localhost:8080** 页面的「④ 契约演进 → 样本影响扫描」卡片进行（需先设置基线并归纳出
当前 Schema），也可直接调用 `POST /api/scan`。每条历史样本都会用 Ajv 分别对基线与当前 Schema
校验一次，然后归入恰好一类：

| 分类 | 含义 | 关注点 |
| --- | --- | --- |
| 两版均通过（`both`） | 基线 ✓ 且当前 ✓ | 演进对这些样本无影响 |
| 仅基线通过（`baselineOnly`） | 基线 ✓ 但当前 ✗ | **升级后将被拒绝的历史流量，需重点核对** |
| 仅当前通过（`currentOnly`） | 基线 ✗ 但当前 ✓ | 此前不合规、当前 Schema 起被接受 |
| 两版均失败（`neither`） | 基线 ✗ 且当前 ✗ | 本就不符合基线契约 |

- 输入必须是一个 JSON 数组（每个元素为一条历史样本）；单次最多 **200** 条。
  输入非数组或超限时，接口返回 `400` 及明确错误信息，前端也会在提交前拦截并提示。
- 结果按类分组展示数量与样本索引（`#` 前缀为样本在数组中的下标）；展开单条样本可查看
  基线/当前两侧的校验结论，失败侧列出全部 Ajv 错误（JSON Pointer、关键字、信息、规则路径）。
- 重新归纳或更换基线后，旧扫描结果会自动失效清空，需重新扫描。

## 历史样本迁移：操作规划与原子执行

迁移在 **http://localhost:8080** 页面的「④ 契约演进 → 历史样本迁移」卡片进行（需先设置基线并
归纳出当前 Schema），也可直接调用 `POST /api/migrate`。请求包含基线（可选）与当前 Schema、
旧样本数组与映射数组；每条映射形如 `{ "from": "/phone", "to": "/contact/phone", "default"?: <JSON 值> }`。

**Pointer 规则（RFC 6901）**：

- 源与目标均须以 `/` 开头，`~` 仅允许 `~0`（表示 `~`）、`~1`（表示 `/`）；源路径允许空串
  `""`（表示把整条样本作为一个值移动）。
- 目标路径末段 `-` 表示数组末尾追加；`-` 出现在非末段、目标为根（`""`）、源与目标相同均非法。
- 数字段在数组位置按 RFC 6901 解释为下标：`0` 或无前导零的正整数。

**先规划、后执行（按路径深度）**：

1. **全局规划与样本无关**：源移除按路径深度**由深到浅**排序（同一数组父级的数字下标由大到小，
   仅为确定、可读的计划顺序——删除留下空位，不会挤压后续下标）；目标写入按深度**由浅到深**
   排序（先放父容器再写子节点），顺序在响应 `plan.sourceRemovals / plan.targetWrites` 中返回。
2. **阶段 A 抽取**：按规划顺序在样本克隆上读取并摘出每个命中的源值（深路径先摘，再移动其
   祖先子树）；源缺失时，配置了默认值则进入补值操作，否则记为跳过（附原因）。所有源值在写
   入前先抽取，因此交换 `/a→/b`、`/b→/a` 与链路 `/a→/b`、`/b→/c` 都能正确完成。
   **数组各层下标始终按迁移前的元素位置定位**：从数组摘出元素时留下**空位**（占位符）而不是
   立即挤压数组，后续抽取与所有目标写入都仍按原下标解析——交换 `/arr/0` 与 `/arr/1` 时，
   未移动的元素（如 `["A","B","C"]` 中的 `C`）原地保留、绝不丢失，且结果与映射填写顺序无关。
3. **阶段 B 写入**：缺失的中间容器按下一段类型自动创建（数字下标 / `-` → 数组，其余 → 对象）；
   末段 `-` 向数组末尾追加，数字下标在现有数组上仅允许替换已有元素或在长度处追加一位
   （不产生空洞）。写入落到（或穿过）源移动留下的空位时视为**重新填入**该位置，填入的值保留。
4. **阶段 C 压缩**：全部目标写入完成后，统一递归压缩数组中仍然空着的空位（被整体移走的子树
   内部的空位一并压缩），幸存元素的相对顺序不变；已被重新填入的空位是普通数据，不受影响。

**原子执行与冲突**（任一冲突 → 整条样本回滚，`before` 保持输入原样、`after` 为 `null`，
`reasons` 逐条说明）：

- 目标位置在原样本中**已存在值**，且没有生效的源移动恰好移除该位置或其祖先（拒绝静默覆盖）；
- 两个操作最终写入同一具体路径（两个 `-` 追加会解析为不同下标，允许并存）；
- 目标路径中途穿过已有或刚写入的标量；对数组使用非数字键、数字下标越界（不允许跳位）；
- 注意：**目标父子路径重叠**（如 `/x` 与 `/x/y` 同为目标）无法确定语义，属映射配置错误，
  在规划阶段直接拒绝（422）；源父子重叠则按深度顺序正常支持。

**校验与汇总**：未发生冲突的迁移结果用 Ajv 按**当前 Schema** 校验，归入：

| 状态 | 含义 |
| --- | --- |
| 成功（`success`） | 迁移已执行且通过当前 Schema 校验 |
| 冲突（`conflict`） | 检测到冲突，整条样本未改动（附原因）；同时附原样本对基线/当前的校验结论 |
| 校验失败（`invalid`） | 迁移已执行但未通过当前 Schema（附全部 Ajv 错误：Pointer、关键字、信息、规则路径） |

- 提供基线 Schema 时，响应还包含**原样本对基线**的校验结论，可判断迁移是否「治好」旧样本。
- 界面「仅复制成功结果」复制的是成功样本的 `after` 数组（保持输入顺序）。
- 单次最多 **200** 条样本；样本集非数组/为空、映射集为空、映射字段类型错误返回 400；
  Schema 无法编译或映射配置语义非法返回 422（携带 `invalidMappings` 明细）。
- 重新归纳或更换基线后，旧迁移结果自动失效清空，需重新迁移。
- **结果与提交时的输入绑定**：每次迁移的结果同时绑定提交那一刻的旧样本文本、完整映射配置
  （源/目标路径与默认值）以及基线、当前两版 Schema。迁移成功后再修改旧样本、任一映射路径或
  默认值、或切换基线/当前 Schema，旧的汇总、单条明细与「仅复制成功结果」入口会**立即隐藏**并
  提示重新迁移，避免导出与当前配置不符的样本。
- **进行中的请求防回填**：请求未返回时切换基线/当前 Schema（或改动样本与映射），该请求随即作废；
  过期响应返回时既不会回填错误，也不会覆盖随后发起的新一轮迁移。只有输入仍与提交时完全一致时，
  其成功或失败结果才会被接纳；重新执行后，展示与复制的均为本次迁移的结果。

## 发布门禁：判定规则

门禁完全在浏览器内基于当前 `/api/diff` 结果计算，不发起额外请求：

| 契约差异（当前视角） | 放行条件 |
| --- | --- |
| 存在破坏性变更 | 仅**主版本**提升可放行（如 `1.2.3` → `2.0.0`，含 `2.0.0-alpha.1`） |
| 仅有兼容/提示级变更 | 至少**次版本**提升（如 `1.2.3` → `1.3.0`） |
| 无契约变化 | **补丁级**发布即可（含同数值版本的预发布递进，如 `1.2.3-alpha` → `1.2.3`） |
| 目标版本 ≤ 基线版本 | 降级或同版本**一律阻止** |

版本解析遵循 SemVer 2.0.0：支持可选 `v` 前缀（`v1.2.3`）与预发布标识（`1.0.0-alpha.1`），
比较时先比主/次/补丁数值，再按预发布优先级（预发布 < 正式版，数字标识符按数值、字母标识符按
ASCII 比较）；构建元数据（`+build`）可解析但不参与比较。结论区展示实际升级类型、门禁要求、
触发结论的变更数量与原因；「复制门禁报告」生成包含版本、视角、差异汇总与结论的 JSON。

## 事件变体契约：规则与入口

入口：**http://localhost:8080** 页面的「⑤ 事件变体」页签，或直接调用 `POST /api/variant`。
适合同一接口下有多种事件形态的场景（如 `{"type": "created", ...}` 与 `{"type": "deleted", ...}`）：
填写判别字段的 JSON Pointer 后点击「生成事件变体契约」，系统按该字段的取值把样本分组，
每组复用归纳引擎生成一个分支 Schema，最终合并为一份带 `oneOf` 的契约。

**判别 Pointer（RFC 6901）**：

- 须以 `/` 开头，逐段按**对象属性**查找（如 `/type`、`/meta/event`）；`~` 转义仅支持
  `~0`（表示 `~`）与 `~1`（表示 `/`），可定位含特殊字符的键名。
- 转义非法（如 `/a~2b`、未以 `/` 开头）时，所有样本均不参与生成并逐条标注原因，请求被拒绝（422）。
- 空字符串 `""` 表示根节点（仅对标量样本有意义）；界面留空时不发起生成。

**分组规则**：

- 仅字符串、数字、布尔值参与分组；取值按类型区分——`1`、`"1"`、`true` 是三个不同分组。
- 判别字段**缺失**，或该位置的值为**对象 / 数组 / null** 的样本不参与生成，
  结果区按样本序号逐条列出原因。
- 分组（及 oneOf 分支）按判别值在样本中首次出现的顺序排列。

**分支 Schema 规则**：

- 每个分支由该组样本经归纳引擎生成：仅**组内共同存在**的字段进入 `required`。
- 判别字段在分支内被约束为对应 `const`（嵌套路径上的每一级都会确保进入 `required`），
  因此各分支互斥，恰好匹配一个分支的 `oneOf` 语义成立。
- 树形视图中判别字段节点带 `const` 徽章，样本路径标注已换算回全局样本序号。

**产出与拒绝**：

- 有效分组不足 2 个时拒绝产出（HTTP 422），响应仍携带分组概要与跳过明细，界面同步展示。
- 成功时界面展示分组数量、有效样本数与各分支 Schema，可一键复制完整契约；
  点击「在校验页验证 →」跳转到「③ 校验新样本」并以该变体契约为校验目标
  （校验页也可随时在「归纳 Schema / 事件变体契约」之间切换校验目标）。
- 单次最多 200 条样本；任何样本或判别字段修改都会使上次生成结果失效。

## 匿名化导出：规则与替换

入口：**http://localhost:8080** 页面的「① 样本输入 → 匿名化导出」区，或直接调用
`POST /api/anonymize`。每条规则是一个 JSON Pointer 模式，后端递归匹配全部样本（最多 200 条），
把命中位置的标量替换为假名后返回整组匿名化样本。

**规则语法（RFC 6901 + 通配）**：

- 须以 `/` 开头（空串 `""` 表示样本根）；`~` 转义仅支持 `~0`（表示 `~`）与 `~1`（表示 `/`）。
- 单段 `*` 通配该层的任意对象键或数组下标（如 `/tags/*`、`/address/*`、`/*`）；
  字面数字段按 RFC 6901 作为数组下标匹配（如 `/tags/0`）。
- 匹配在标量、缺失键与越界下标处安静停止——未命中不是错误，结果区以「未命中」标记该规则。

**替换规则**：

| 原值类型 | 假名形式 |
| --- | --- |
| 字符串 | `anon_<12 位哈希>`（由规则模式与原值确定性生成） |
| 整数 | 确定性 9 位整数（**不会变成小数**） |
| 浮点 | 确定性非整数（不会变成整数） |
| 布尔 | 取反（布尔域上唯一同时满足单射与隐藏原值的映射） |
| null | `null`（唯一可能取值） |

- **跨样本稳定**：同一规则下，相同原值在任何样本中都映射为同一假名；不同原值绝不合并
  （哈希碰撞时自动重播种）。相同输入重复导出结果完全一致。
- **拒绝生成（HTTP 422）**：规则不是合法 JSON Pointer；任一命中落在对象或数组上；
  两条不同规则在同一样本命中同一路径（如 `/a/*` 与 `/a/b` 同时命中 `#/0/a/b`）。
  拒绝时响应仍携带各规则的命中数、命中路径与错误原因，界面同步展示。
- **界面流程**：点击「预览匿名化」先展示各规则命中数、未命中项与错误，生成成功后才出现
  「复制匿名化样本」与 JSON 预览；规则或原样本有任何修改，上次预览立即失效。

## 契约切片：规则与入口

入口：**http://localhost:8080** 页面的「⑥ 契约切片」页签（需先在「① 样本输入」归纳出
Schema），或直接调用 `POST /api/slice`。在 Schema 树勾选 1～20 个节点后点击「生成契约切片」，
后端生成仅保留所选节点及必要祖先结构的独立 Schema，并把每条样本沿相同路径投影。

**勾选与 Pointer（Schema 树指针，RFC 6901）**：

- 勾选对象属性对应 `/properties/<键>`、数组元素对应 `/items`，根节点为空串 `""`；
  `~` 转义仅支持 `~0`（表示 `~`）与 `~1`（表示 `/`）。
- **祖先已选时忽略其子项**：被其他已选 Pointer 覆盖的子项、以及完全重复的 Pointer 会被忽略，
  结果区的 `ignored` 列表逐条标注原因（与勾选顺序无关）。
- Pointer 非法或指向 Schema 中不存在的节点时拒绝生成（HTTP 422），并逐条列出原因。

**切片 Schema 规则**：

- 对象只保留通向（或位于）所选节点的 `properties`；`required` 仅保留**原本必填且仍存在**
  的字段；数组沿 `items` 递归；`type` 联合、`const` 及其余非结构性关键字保持不变。
- 被完整选中的子树原样保留；根节点自动携带 `$schema`（2020-12）标记。

**样本投影规则**：

- 选中的子树整体克隆；祖先对象只保留选择路径上的键；祖先数组把每个元素沿 `items` 选择
  递归投影；样本值在祖先链上无法继续细分时（标量，或形状与所选路径不符的数组/对象），
  该终端值按原样保留。
- 后端用 Ajv 把每条投影样本对切片 Schema 校验一次：**任一失败则不产出**（HTTP 422），
  响应携带失败样本索引（`failures[].index`，从 0 开始）与完整 Ajv 错误（Pointer、关键字、
  信息、规则路径），界面按样本分组展示。

**产出与失效**：

- 成功时界面预览**字段数**（切片 Schema 中递归统计的 `properties` 字段总数）与**样本数**，
  可分别「复制切片 Schema」与「复制投影样本」，也可展开查看对应 JSON。
- 选择或样本有任何变化，上次切片结果立即失效，需重新生成。
- 单次最多 200 条样本、20 个 Pointer；超限时接口返回 `400` 及明确错误信息。

## 字段关系挖掘：规则与入口

入口：**http://localhost:8080** 页面的「⑦ 字段关系」页签（需先在「① 样本输入」归纳出
Schema），或直接调用 `POST /api/relation/mine` 与 `POST /api/relation/enhance`。

**作用域统计（禁止跨作用域关联）**：

- 每个对象实例是一个独立的**对象 Pointer 作用域**：根样本为对象时属于根作用域（Pointer `""`），
  对象属性形成 `/properties/<键>` 作用域，数组的**每个对象元素**各自独立计入同一个
  `/items` 作用域（同一数组两个元素就是两个独立观测）。
- 父对象的字段与数组元素内的字段、不同数组元素的字段之间**绝不关联**；样本在该位置是
  标量 / null（类型并集情形）时该作用域不计入。
- 每个作用域统计：对象总数、各字段出现次数、字段同时出现 / 不共现关系；观测路径形如
  `#/<样本序号>/<路径>`（如 `#/0/list/2/a`），数组下标逐段保留。

**候选规则（支持数 ≥ 2、置信度 100%）**：

| 类型 | 条件（同一作用域内） | 支持数 |
| --- | --- | --- |
| 蕴含 A → B | 所有含 A 的作用域都含 B（无反例） | 含 A 的作用域数 |
| 互斥 A / B | 不存在任何作用域同时含 A、B | min(含 A 数, 含 B 数) |

- 阈值两侧（含 A、含 B）都须 ≥ 2；互斥要求共现数为 0，蕴含要求置信度严格 100%。
- **蕴含做传递约简**：每个作用域内把蕴含关系视为有向图，强连通分量（互为蕴含，即字段出现
  集合完全相同）保留一条覆盖全部分量的有向环，分量间的 DAG 边若可被 ≥ 2 条边的路径推导则
  删除；结果区展示约简去除的边数。
- 已被归纳 Schema 的 `required` 天然覆盖的蕴含（目标字段本就必填）会标注「已被 required
  覆盖」，默认不参与增强、仅折叠展示。

**观测路径与支持样本**：每条规则展示规则形式、作用域 Pointer、支持数 / 作用域总数
（互斥另显示两侧出现数与共现 0）、支持样本序号（点击可定位到原始样本编辑器）与全部观测路径
（超过 50 条截断提示）；互斥分别列出含 A 与含 B 两侧的路径。

**增强 Schema 与 Ajv 复验**：勾选候选后点击「生成增强 Schema」：

- 蕴含 A → B 注入该作用域 Schema 节点的 `dependentRequired: { A: ["B"] }`（同一前件的多条
  规则合并为一个数组）；互斥 A / B 注入 `allOf: [{ not: { required: ["A", "B"] } }]`
  （多条互斥各自成为 `allOf` 的一项，可并存）。
- **特殊键名 `__proto__`（无论作为前件还是后件）一律按对象自身字段（own property）的存在性
  判断，不读原型链**。普通的 `dependentRequired` / `required` 会把 `__proto__` 特殊对待：Ajv
  跳过字面的 `dependentRequired.__proto__` 条目，而 `required: ["__proto__"]` 在未开启
  `ownProperties` 时读到的是继承来的原型槽位，导致仅含 `__proto__`（缺后件）或仅含另一键
  （缺 `__proto__`）的违规新样本误判通过、或只含另一键的合规样本被误拒。因此凡涉及
  `__proto__` 的蕴含 / 互斥，增强 Schema 改用基于 `propertyNames` 的自身键存在性断言
  （蕴含：`{ if: <自身含 A>, then: <自身含 B> }`；互斥：
  `{ not: { allOf: [<自身含 A>, <自身含 B>] } }`，其中 `<自身含 K>` 为
  `{ "not": { "propertyNames": { "not": { "const": "K" } } } }`）。`propertyNames` 枚举的是
  实例自身的可枚举属性名，绝不经过 `Object.prototype`，故校验器即使不开启 Ajv 的
  `ownProperties` 选项、且字段值为 `null` / `undefined` 时判定也保持一致；根对象、嵌套对象
  与数组元素作用域均在对应 Schema 节点上施加同一约束。普通字段的落地形式与 API 形态不变。
- 后端在生成后用 Ajv 对**全部原样本**复验：**任一样本不通过则不产出**（HTTP 422），响应
  携带失败样本索引（`failures[].index`）与完整 Ajv 错误；所选规则因样本变化失效（重挖后
  找不到该规则 id）同样 422 拒绝并逐条列出。
- 成功后可一键复制增强 Schema，或「在校验页验证 →」切到「③ 校验新样本」以该 Schema 为
  校验目标；任何样本或勾选变化都会使上次增强结果失效。
- 单次最多 200 条样本；样本集非数组 / 为空、规则 id 非字符串返回 400，Schema 无法编译或
  复验失败返回 422。

## 本地开发

```bash
npm run setup        # 安装 server 与 client 依赖
npm run dev:server   # 后端 http://localhost:8080（--watch 热重载）
npm run dev:client   # 前端 http://localhost:5173（/api 代理到 8080）
```

生产模式本地运行：`npm run build && npm start`，访问 http://localhost:8080。

## 测试

```bash
npm test             # node:test，覆盖归纳引擎、契约比较器、反例生成器、样本影响扫描、样本贡献度、事件变体契约、匿名化导出、契约切片、历史样本迁移（含输入绑定/过期响应判定）、字段关系挖掘（含规则标识无碰撞、__proto__ 自身键存在性）、错误热点聚簇、HTTP API 与发布门禁（271 项）
```

## API

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ "status": "ok" }` |
| POST | `/api/infer` | `{ "samples": [<any>, ...] }` | `{ schema, paths, sampleCount }` |
| POST | `/api/validate` | `{ "schema": {...}, "sample": <any> }` | `{ valid, errors: [{ path, pointer, schemaPath, keyword, message, params }] }` |
| POST | `/api/hotspots` | `{ "schema": {...}, "samples": [<any>, ...] }`（≤ 200 条） | `{ total, validCount, invalidCount, errorCount, clusterCount, clusters: [{ schemaPath, keyword, missingProperty?, additionalProperty?, sampleCount, errorCount, sampleIndexes, occurrences: [{ index, path, pointer, message, params }] }] }`（簇按受影响样本数降序） |
| POST | `/api/diff` | `{ "oldSchema": {...}, "newSchema": {...}, "perspective": "request" \| "response" }` | `{ perspective, changes: [{ pointer, kind, field?, severity, oldRule, newRule, reason }], summary: { breaking, compatible, info } }` |
| POST | `/api/counterexample` | `{ oldSchema, newSchema, perspective, kind, pointer }` | `{ constructible, sample?, oldResult: { valid, errors }, newResult: { valid, errors }, reason? }` |
| POST | `/api/scan` | `{ oldSchema, newSchema, samples: [<any>, ...] }`（≤ 200 条） | `{ total, summary: { both, baselineOnly, currentOnly, neither }, samples: [{ index, category, baseline: { valid, errors }, current: { valid, errors } }] }` |
| POST | `/api/contribution` | `{ samples: [<any>, ...] }`（1–50 条） | `{ total, summary: { critical, redundant }, samples: [{ index, verdict, affectedPointers }] }` |
| POST | `/api/variant` | `{ samples: [<any>, ...], pointer: "/type" }`（≤ 200 条） | `{ pointer, totalSamples, validSamples, groupCount, groups: [{ value, count, sampleIndexes, schema, paths }], skipped: [{ index, reason }], schema: { $schema, oneOf } }`；有效分组不足 2 个或 Pointer 非法时返回 422，响应体仍携带分组概要与跳过明细 |
| POST | `/api/anonymize` | `{ samples: [<any>, ...], rules: ["/email", "/tags/*"] }`（≤ 200 条） | `{ totalSamples, rules: [{ index, pattern, status, hits, paths, pathsTruncated, error }], samples: [<匿名化样本>] }`；非法 Pointer、命中对象/数组或规则间路径冲突时返回 422，响应体仍携带各规则统计 |
| POST | `/api/slice` | `{ schema: {...}, samples: [<any>, ...], pointers: ["/properties/a", "/properties/tags/items"] }`（样本 ≤ 200 条，Pointer 1–20 个，`""` 表示根） | `{ schema, samples, fieldCount, sampleCount, pointers, ignored: [{ pointer, reason }] }`；Pointer 非法/未命中返回 422 并携带 `invalidPointers`，任一投影样本未通过 Ajv 校验返回 422 并携带 `failures: [{ index, errors }]`，均不产出切片 |
| POST | `/api/migrate` | `{ baselineSchema?: {...}, currentSchema: {...}, samples: [<any>, ...]（≤ 200）, mappings: [{ from: "/a", to: "/b", default?: <JSON> }] }`（源可用 `""` 表示根；目标末段 `-` 追加数组） | `{ total, summary: { success, conflict, invalid }, plan: { sourceRemovals: [{ mapping, pointer }], targetWrites: [{ mapping, pointer }] }, mappings: [{ index, from, to, hasDefault }], samples: [{ index, status, before, after, reasons, operations: [{ kind, from?, to, reason? }], baseline: { valid, errors }?, current: { valid, errors } }] }`；映射语义非法（非法 Pointer、目标为根、源目标相同、源重复、目标父子重叠、`-` 位置错误）返回 422 并携带 `invalidMappings`，冲突样本 `after` 为 `null` 且保持原样 |
| POST | `/api/relation/mine` | `{ samples: [<any>, ...]（≤ 200）, schema?: {...} }`（schema 可选，传入时标注已被 `required` 覆盖的蕴含） | `{ sampleCount, scopeCount, minSupport: 2, summary: { implication, exclusion, removedByTransitiveReduction }, scopes: [{ scopePointer, scopeCount, fields: [{ name, count }], implications: [{ id, kind, scopePointer, a, b, support, scopeCount, confidence, sampleIndexes, witnessPaths, witnessPathsTruncated, alreadyEnforced }], exclusions: [{ id, kind, scopePointer, a, b, support, countA, countB, coOccurrence, scopeCount, confidence, sampleIndexes, witnessPathsA, witnessPathsB, witnessPathsTruncated }] }] }` |
| POST | `/api/relation/enhance` | `{ schema: {...}, samples: [<any>, ...]（≤ 200）, ruleIds: ["implication\|0:\|1:a->1:b", "exclusion\|0:\|1:a<x>1:b"] }` | `{ schema, sampleCount, ruleCount, ruleIds, rules }`；规则 id 失效返回 422 并携带 `invalidRules`；任一原样本未通过增强 Schema 的 Ajv 复验返回 422 并携带 `failures: [{ index, errors }]`，均不产出 Schema。规则 id 形如 `<类型>|<作用域长度>:<作用域>|<A长度>:<A><连接符><B长度>:<B>`（蕴含连接符 `->`、互斥 `<x>`），对类型、作用域 Pointer 与两个原始字段名做长度定界，含 `|`、`->`、`<x>`、`:` 或 RFC 6901 转义字符（`~`、`/`）的字段名也不会撞 id，应视为不透明字符串原样回传 |

示例：

```bash
curl -X POST http://localhost:8080/api/infer \
  -H 'Content-Type: application/json' \
  -d '{"samples":[{"id":1,"phone":null},{"id":2,"phone":"123"}]}'
```

错误热点聚簇（逐条校验待检样本，按 schemaPath + keyword 聚簇，required/additionalProperties 按字段分簇）：

```bash
curl -X POST http://localhost:8080/api/hotspots \
  -H 'Content-Type: application/json' \
  -d '{"schema":{"type":"object",
                  "properties":{"id":{"type":"integer"},
                                "name":{"type":"string"},
                                "tags":{"type":"array","items":{"type":"string"}}},
                  "required":["id","name"],"additionalProperties":false},
       "samples":[{"id":"x","tags":["a",1],"extra":true},
                  {"id":1,"name":"ok","tags":["a"]},
                  {"id":2,"tags":[2,3]}]}'
# -> { "total": 3, "validCount": 1, "invalidCount": 2, "errorCount": 7, "clusterCount": 4,
#      "clusters": [
#        { "schemaPath": "#/properties/tags/items/type", "keyword": "type",
#          "sampleCount": 2, "errorCount": 3, "sampleIndexes": [0, 2],
#          "occurrences": [{ "index": 0, "pointer": "/tags/1", ... },
#                          { "index": 2, "pointer": "/tags/0", ... }, ...] },
#        { "schemaPath": "#/required", "keyword": "required", "missingProperty": "name",
#          "sampleCount": 2, "errorCount": 2, ... },
#        { "schemaPath": "#/additionalProperties", "keyword": "additionalProperties",
#          "additionalProperty": "extra", "sampleCount": 1, ... },
#        { "schemaPath": "#/properties/id/type", "keyword": "type", "sampleCount": 1, ... } ] }
# —— 数组下标 /tags/0 与 /tags/1 的报错并入同一簇；缺少 name 与多出 extra 各自成簇
```

为破坏性变更生成反例（请求体视角：样本须通过旧版、被新版拒绝）：

```bash
curl -X POST http://localhost:8080/api/counterexample \
  -H 'Content-Type: application/json' \
  -d '{"oldSchema":{"type":"object","properties":{"phone":{"type":["null","string"]}},"required":["phone"]},"newSchema":{"type":"object","properties":{"phone":{"type":"string"}},"required":["phone"]},"perspective":"request","kind":"type","pointer":"/properties/phone"}'
# -> { "constructible": true, "sample": { "phone": null },
#      "oldResult": { "valid": true, "errors": [] },
#      "newResult": { "valid": false, "errors": [...] } }
```

扫描历史样本集（逐条按基线与当前 Schema 双侧校验并归类）：

```bash
curl -X POST http://localhost:8080/api/scan \
  -H 'Content-Type: application/json' \
  -d '{"oldSchema":{"type":["string","null"]},"newSchema":{"type":["string","integer"]},"samples":["s",null,5,false]}'
# -> { "total": 4,
#      "summary": { "both": 1, "baselineOnly": 1, "currentOnly": 1, "neither": 1 },
#      "samples": [
#        { "index": 0, "category": "both", "baseline": {...}, "current": {...} },
#        { "index": 1, "category": "baselineOnly", ... }, ... ] }
```

留一法分析样本贡献度（按样本索引汇总类型/字段出现/数组元素证据，逐条扣除贡献判定关键/冗余）：

```bash
curl -X POST http://localhost:8080/api/contribution \
  -H 'Content-Type: application/json' \
  -d '{"samples":[{"id":1,"tag":"x"},{"id":2,"tag":"y"},{"id":3}]}'
# -> { "total": 3,
#      "summary": { "critical": 1, "redundant": 2 },
#      "samples": [
#        { "index": 0, "verdict": "redundant", "affectedPointers": [] },
#        { "index": 1, "verdict": "redundant", "affectedPointers": [] },
#        { "index": 2, "verdict": "critical",  "affectedPointers": ["/properties/tag"] } ] }
```

按判别字段分组取值生成事件变体契约（oneOf 分支 + const 判别值）：

```bash
curl -X POST http://localhost:8080/api/variant \
  -H 'Content-Type: application/json' \
  -d '{"pointer":"/type","samples":[
        {"type":"created","id":1,"payload":{"a":1}},
        {"type":"created","id":2},
        {"type":"deleted","id":3,"reason":"x"},
        {"id":4}]}'
# -> { "groupCount": 2, "validSamples": 3, "totalSamples": 4,
#      "skipped": [{ "index": 3, "reason": "判别字段缺失" }],
#      "groups": [
#        { "value": "created", "count": 2, "sampleIndexes": [0, 1],
#          "schema": { ..., "properties": { "type": { "type": "string", "const": "created" }, ... },
#                      "required": ["type", "id"] } },
#        { "value": "deleted", "count": 1, "sampleIndexes": [2],
#          "schema": { ..., "required": ["type", "id", "reason"] } } ],
#      "schema": { "$schema": ".../2020-12/schema", "oneOf": [<两个分支>] } }
```

按 JSON Pointer 规则匿名化导出样本（跨样本稳定、类型保留的假名替换）：

```bash
curl -X POST http://localhost:8080/api/anonymize \
  -H 'Content-Type: application/json' \
  -d '{"samples":[
        {"id":1,"email":"alice@example.com","tags":["admin","owner"]},
        {"id":2,"email":"alice@example.com","tags":["user"]}],
       "rules":["/email","/tags/*"]}'
# -> { "totalSamples": 2,
#      "rules": [
#        { "index": 0, "pattern": "/email", "status": "ok", "hits": 2,
#          "paths": ["#/0/email", "#/1/email"], "pathsTruncated": false, "error": null },
#        { "index": 1, "pattern": "/tags/*", "status": "ok", "hits": 3,
#          "paths": ["#/0/tags/0", "#/0/tags/1", "#/1/tags/0"], ... } ],
#      "samples": [
#        { "id": 1, "email": "anon_1e56769b6009", "tags": ["anon_...", "anon_..."] },
#        { "id": 2, "email": "anon_1e56769b6009", "tags": ["anon_..."] } ] }
#      —— 相同原值（alice@example.com）跨样本映射一致，id 未命中规则保持原样
```

勾选 Schema 树节点生成契约切片（仅保留所选结构，同步投影样本）：

```bash
# 先归纳出 Schema，再按需切片
SCHEMA=$(curl -s -X POST http://localhost:8080/api/infer \
  -H 'Content-Type: application/json' \
  -d '{"samples":[{"id":1,"address":{"city":"Shanghai","zip":"200000"}},{"id":2,"address":{"city":"Beijing","zip":"100000"}}]}' \
  | jq '.schema')

curl -X POST http://localhost:8080/api/slice \
  -H 'Content-Type: application/json' \
  -d "{\"schema\":$SCHEMA,\"samples\":[{\"id\":1,\"address\":{\"city\":\"Shanghai\",\"zip\":\"200000\"}},{\"id\":2,\"address\":{\"city\":\"Beijing\",\"zip\":\"100000\"}}],\"pointers\":[\"/properties/address/properties/city\"]}"
# -> { "schema": { "type": "object", "$schema": ".../2020-12/schema",
#                   "properties": { "address": { "type": "object",
#                      "properties": { "city": { "type": "string" } },
#                      "required": ["city"] } },
#                   "required": ["address"] },
#      "samples": [{ "address": { "city": "Shanghai" } },
#                  { "address": { "city": "Beijing" } }],
#      "fieldCount": 2, "sampleCount": 2,
#      "pointers": ["/properties/address/properties/city"], "ignored": [] }
# —— id 未命中被裁掉；若某条投影样本未通过切片 Schema 的 Ajv 校验，
#    则整体返回 422 并在 failures 中给出样本索引与错误
```

按「源 → 目标」JSON Pointer 映射迁移历史样本（先按深度规划、逐条原子执行，再按当前 Schema 校验）：

```bash
curl -X POST http://localhost:8080/api/migrate \
  -H 'Content-Type: application/json' \
  -d '{
        "baselineSchema": {"type":"object","properties":{"id":{"type":"integer"},"phone":{"type":["null","string"]}},"required":["id","phone"]},
        "currentSchema": {"type":"object","properties":{"id":{"type":"integer"},"contact":{"type":"object","properties":{"phone":{"type":"string"}},"required":["phone"]},"v":{"type":"integer"}},"required":["id","contact","v"]},
        "samples": [
          {"id":1,"phone":"123"},
          {"id":2,"phone":null},
          {"id":3,"contact":{"phone":"000"}}
        ],
        "mappings": [
          {"from":"/phone","to":"/contact/phone"},
          {"from":"/version","to":"/v","default":1}
        ]
      }'
# -> { "total": 3,
#      "summary": { "success": 2, "conflict": 0, "invalid": 1 },
#      "plan": { "sourceRemovals": [{ "mapping": 0, "pointer": "/phone" }, ...],
#                "targetWrites": [{ "mapping": 1, "pointer": "/v" }, ...] },
#      "samples": [
#        { "index": 0, "status": "success",
#          "before": { "id": 1, "phone": "123" },
#          "after":  { "id": 1, "v": 1, "contact": { "phone": "123" } },
#          "operations": [{ "kind": "move", "from": "/phone", "to": "/contact/phone" },
#                         { "kind": "default", "to": "/v" }], ... },
#        { "index": 1, "status": "invalid",
#          "after": { "id": 2, "v": 1, "contact": { "phone": null } },
#          "current": { "valid": false, "errors": [{ "pointer": "/contact/phone", "keyword": "type", ... }] } },
#        { "index": 2, "status": "success",
#          "operations": [{ "kind": "skip", "from": "/phone", ... }, { "kind": "default", ... }],
#          "after": { "id": 3, "contact": { "phone": "000" }, "v": 1 } } ] }
# —— #1 迁移完成但 null 不满足当前的 string，归为校验失败；#2 源缺失且无默认值的移动被跳过，
#    默认值照常补入；目标已存在且未被源移动覆盖的样本会归为 conflict 并保持原样
```

挖掘字段关系并生成增强 Schema（蕴含 → dependentRequired，互斥 → not/required，原样本全部复验）：

```bash
# 1) 挖掘候选（数组元素各自独立计入 /items 作用域，不跨作用域关联）
curl -s -X POST http://localhost:8080/api/relation/mine \
  -H 'Content-Type: application/json' \
  -d '{"samples":[
        {"kind":"created","at":"2026-01-01"},
        {"kind":"created","at":"2026-01-02"},
        {"kind":"deleted","reason":"spam"},
        {"kind":"deleted","reason":"dup"}]}'
# -> { "scopeCount": 4, "summary": { "implication": 2, "exclusion": 1, ... },
#      "scopes": [{ "scopePointer": "",
#        "implications": [{ "id": "implication|0:|2:at->4:kind", "support": 2, ... },
#                         { "id": "implication|0:|6:reason->4:kind", "support": 2, ... }],
#        "exclusions":   [{ "id": "exclusion|0:|2:at<x>6:reason", "support": 2,
#                           "witnessPathsA": ["#/0", "#/1"],
#                           "witnessPathsB": ["#/2", "#/3"], ... }] }] }
# —— id 对类型/作用域/两个原始字段名做长度定界，字段名含 |、->、<x>、~、/ 也不撞 id；客户端原样回传即可

# 2) 勾选互斥规则生成增强 Schema（后端按当前样本重新挖掘校验规则 id，并用 Ajv 复验全部原样本）
curl -s -X POST http://localhost:8080/api/relation/enhance \
  -H 'Content-Type: application/json' \
  -d '{"schema":{"type":"object",
                  "properties":{"kind":{"type":"string"},"at":{"type":"string"},"reason":{"type":"string"}},
                  "required":["kind"]},
       "samples":[
         {"kind":"created","at":"2026-01-01"},
         {"kind":"created","at":"2026-01-02"},
         {"kind":"deleted","reason":"spam"},
         {"kind":"deleted","reason":"dup"}],
       "ruleIds":["exclusion|0:|2:at<x>6:reason"]}'
# -> { "ruleCount": 1, "sampleCount": 4,
#      "schema": { ..., "allOf": [{ "not": { "required": ["at", "reason"] } }] } }
# —— 任一样本复验失败（或规则 id 已失效）时返回 422 且不产出 schema
```

字段名恰好为 `__proto__` 时（键名按 JSON 文本提交，由服务端 body parser 解析为对象自身键；
切勿用 JS 对象字面量构造），勾选蕴含后违规新样本在两个方向上都会被拒绝，且全部原样本仍复验
通过（根对象 / 嵌套对象 / 数组元素作用域同理）：

```bash
# 两条样本同时含 "__proto__" 与 b，第三条两者都不含
SAMPLES='[ {"__proto__":1,"b":2}, {"__proto__":3,"b":4}, {"c":5} ]'

# 1) 挖掘：两个方向的蕴含候选都会出现（id 中 __proto__ 按原始键名长度定界）
curl -s -X POST http://localhost:8080/api/relation/mine \
  -H 'Content-Type: application/json' \
  -d "{\"samples\":$SAMPLES}"
# -> implications: [{ "id": "implication|0:|9:__proto__->1:b", "a": "__proto__", "b": "b", ... },
#                   { "id": "implication|0:|1:b->9:__proto__", "a": "b", "b": "__proto__", ... }]

# 2) 选 "__proto__" -> b 生成增强 Schema（不写 dependentRequired.__proto__，
#    改为 propertyNames 自身键存在性断言；普通字段仍是 dependentRequired / not+required）
curl -s -X POST http://localhost:8080/api/relation/enhance \
  -H 'Content-Type: application/json' \
  -d "{\"schema\":{\"type\":\"object\",
        \"properties\":{\"__proto__\":{\"type\":\"integer\"},\"b\":{\"type\":\"integer\"},\"c\":{\"type\":\"integer\"}},
        \"patternProperties\":{\"^__proto__$\":{\"type\":\"integer\"}}},
       \"samples\":$SAMPLES,
       \"ruleIds\":[\"implication|0:|9:__proto__->1:b\"]}"
# -> { "ruleCount": 1, "sampleCount": 3,
#      "schema": { ...,
#        "allOf": [ { "if":   { "not": { "propertyNames": { "not": { "const": "__proto__" } } } },
#                    "then": { "not": { "propertyNames": { "not": { "const": "b" } } } } } ] } }

# 3) 仅含 "__proto__" 的新样本必须被拒绝（两个方向对称）
curl -s -X POST http://localhost:8080/api/validate \
  -H 'Content-Type: application/json' \
  -d '{"schema": <上一步返回的 schema>, "sample": {"__proto__": 9}}'
# -> { "valid": false, "errors": [ { "keyword": "if", ... } ] }
```

也可直接运行可调用示例（先 `npm start` 启动服务），它会依次演示挖掘、两个方向的增强、违规新
样本拒绝与全部原样本复验：

```bash
node server/examples/proto-relation.js          # 默认 127.0.0.1:8080
PORT=8091 node server/examples/proto-relation.js
```

## 目录结构

```
├── Dockerfile              # 多阶段：构建前端 → 安装后端依赖 → 精简运行时（非 root）
├── docker-compose.yml      # 单服务，映射 8080
├── package.json            # 根编排脚本（setup/dev/build/start/test）
├── server/
│   ├── infer.js            # 递归归纳引擎（类型并集、required、items 折叠、路径映射）
│   ├── diff.js             # 契约演进比较器（递归对比属性/required/类型联合/items，按视角定级）
│   ├── counterexample.js   # 破坏性反例生成器（递归构造最小 JSON + Ajv 双侧校验）
│   ├── scan.js             # 样本影响扫描器（Ajv 双侧逐条校验 + 四分类，单次上限 200 条）
│   ├── contribution.js     # 样本贡献度分析（按样本索引汇总类型/字段出现次数/数组元素证据，逐条扣除贡献做留一判定，单次上限 50 条）
│   ├── variant.js          # 事件变体契约（判别字段分组 + 逐组归纳 + const 注入，合并 oneOf，单次上限 200 条）
│   ├── anonymize.js        # 匿名化导出（JSON Pointer + 单段 * 通配递归匹配，跨样本稳定、类型保留的假名替换，单次上限 200 条）
│   ├── slice.js            # 契约切片（按勾选的 Schema 树 Pointer 裁剪结构 + 投影样本 + Ajv 逐条校验，样本上限 200 条、Pointer 上限 20 个）
│   ├── migrate.js          # 历史样本迁移（按路径深度规划源移除/目标写入 + 逐样本原子移动/补值；数组下标按迁移前位置定位、空位统一压缩，父子重叠、目标冲突处理 + Ajv 按当前 Schema 校验，上限 200 条）
│   ├── relation.js         # 字段关系挖掘（按对象 Pointer 作用域统计字段出现，数组元素独立计数，支持≥2/置信100% 蕴含与互斥 + 蕴含传递约简；增强 Schema 注入 dependentRequired / not+required，涉及 __proto__ 的规则改用 propertyNames 自身键存在性断言，并用全部原样本 Ajv 复验）
│   ├── examples/
│   │   └── proto-relation.js # 可运行示例：__proto__ 字段参与蕴含时，两个方向的增强/校验 HTTP 全流程
│   ├── hotspot.js          # 错误热点聚簇（Ajv 逐条校验 ≤200 条样本，按 schemaPath+keyword 聚簇，required/additionalProperties 按字段分簇，按受影响样本数降序）
│   ├── app.js              # Express（/api/infer、/api/validate、/api/hotspots、/api/diff、/api/counterexample、/api/scan、/api/contribution、/api/variant、/api/anonymize、/api/slice、/api/migrate、/api/relation/mine、/api/relation/enhance、静态托管）
│   ├── index.js            # 入口：监听 PORT（默认 8080）
│   └── test/               # node:test 单元与 API 测试
└── client/
    ├── test/               # 发布门禁（SemVer 解析/比较/判定）与迁移输入绑定单元测试
    └── src/
        ├── App.jsx                 # 双栏布局、样本管理、归纳/校验/演进/变体流程、基线（sessionStorage）
        ├── gate.js                 # 发布门禁：SemVer 2.0.0 解析/比较 + 放行判定（纯函数）
        ├── migrationBinding.js    # 历史样本迁移的输入绑定指纹与过期响应接纳判定（纯函数）
        ├── components/SchemaTree.jsx   # 树形视图 + 样本路径标注 + const 徽章 + 契约切片可勾选模式
        ├── components/ValidatePanel.jsx # 校验面板：归纳 Schema / 事件变体契约双目标，JSON Pointer 错误列表
        ├── components/HotspotPanel.jsx   # 错误热点：待检样本数组输入、按受影响样本数降序的聚簇列表、样本索引与实例 Pointer 展开
        ├── components/DiffPanel.jsx     # 契约演进面板：视角切换、破坏性筛选、按 Pointer 分组
        ├── components/CounterexamplePanel.jsx # 反例：样本格式化展示、双侧校验结果、复制按钮
        ├── components/SampleScanPanel.jsx  # 样本影响扫描：数组输入、四分类汇总、单条双侧错误展开
        ├── components/MigrationPanel.jsx   # 历史样本迁移：旧样本数组 + 源→目标映射（可选默认值）、深度规划/原子执行、成功/冲突/校验失败汇总、前后对比、仅复制成功结果；结果与提交时样本/映射/两版 Schema 绑定，输入变更立即隐藏并提示重迁，进行中的过期响应不回填
        ├── components/ContributionPanel.jsx # 样本贡献度：留一法分析入口、关键/冗余汇总筛选、定位原样本
        ├── components/AnonymizePanel.jsx    # 匿名化导出：规则编辑、命中/未命中/错误预览、复制匿名化样本
        ├── components/SlicePanel.jsx        # 契约切片：可勾选 Schema 树、字段数/样本数预览、分别复制切片 Schema 与投影样本
        ├── components/RelationPanel.jsx     # 字段关系：按作用域展示蕴含/互斥候选、观测路径与支持样本（可定位），勾选生成 Ajv 复验后的增强 Schema
        ├── components/VariantPanel.jsx    # 事件变体：判别 Pointer 输入、分组/跳过明细、分支 Schema、复制与接入校验
        ├── components/ReleaseGate.jsx   # 发布门禁卡片：版本输入、放行结论、报告复制
        └── components/SampleEditor.jsx  # 样本编辑器（实时 JSON 校验）
```

环境变量：`PORT`（默认 `8080`）。
