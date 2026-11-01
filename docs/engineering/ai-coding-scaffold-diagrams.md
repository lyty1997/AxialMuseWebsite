# AI 编码脚手架文章图表源

本文档维护技术文章
[`ai-coding-scaffold-engineering-loop`](../../site-content/writing/ai-coding-scaffold-engineering-loop/index.md)
的 PlantUML 真相源。每段源码必须紧跟目标 SVG；`npm run check:diagrams`
负责真实编译，设置 `PUML_JAR` 后运行 `npm run gen:diagrams` 可刷新目标文件。

文章正文只引用 SVG，不重复展示 PlantUML 源码。这样公开阅读优先呈现图表，
仓库仍保留可审查、可编译、可再生成的源文件。

## 四层工程控制面

```plantuml
@startuml
skinparam shadowing false
skinparam backgroundColor transparent
skinparam defaultTextAlignment center
skinparam ArrowColor #486581
skinparam rectangleBorderColor #486581
skinparam rectangleBackgroundColor #F0F4F8

rectangle "项目负责人\n目标、取舍、授权" as Owner #D9EAF7
rectangle "1  项目真相层\ndocs/\n事实、决定、计划、未决项" as Docs
rectangle "2  Agent 上下文层\nAGENTS.md + 规则路由\n稳定边界常驻，任务细则按需加载" as Context
rectangle "3  工程执行层\nAgent + 源码 + scripts/\n判断、修改与确定性执行" as Execution
rectangle "4  反馈证据层\n契约 + 本地门禁 + CI\n失败可定位，通过可复核" as Evidence #D9EAD3

Owner -right-> Docs : 写入决定
Docs -right-> Context : 提供事实
Context -down-> Execution : 约束任务
Execution -left-> Evidence : 接受验证
Evidence -up-> Docs : 回写结果与遗留
@enduml
```

![AI 编码脚手架从项目事实到验证证据的四层结构](../../site-content/writing/ai-coding-scaffold-engineering-loop/assets/ai-scaffold-layers.svg)

## 单次任务闭环

```plantuml
@startuml
skinparam shadowing false
skinparam backgroundColor transparent
skinparam defaultTextAlignment center
skinparam ArrowColor #486581
skinparam rectangleBorderColor #486581
skinparam rectangleBackgroundColor #F0F4F8

rectangle "01  装配上下文\ndocs/ + 任务规则" as Load
rectangle "02  分清信息\n用户要求 / 事实 / 决定" as Split
rectangle "03  决策门\n是否仍有关键未决项" as Gate #D9EAF7
rectangle "暂停依赖分支\n说明选项与影响" as Pause #FBE5D6
rectangle "04  先更设计\n设计 / 契约 / 决策记录" as Design
rectangle "05  小步实现\n一次最小修改" as Implement
rectangle "06  运行门禁\n保留真实错误" as Verify
rectangle "07  交付证据\n结果 / 边界 / 遗留" as Evidence #D9EAD3

Load -right-> Split
Split -right-> Gate
Gate -right-> Pause : 未决
Gate -down-> Design : 已明确
Design -left-> Implement
Implement -left-> Verify
Verify -right-> Implement : 失败
Verify -down-> Evidence : 通过
@enduml
```

![AI 编码任务从上下文装配到验证收尾的最短闭环](../../site-content/writing/ai-coding-scaffold-engineering-loop/assets/ai-scaffold-task-loop.svg)

## 脚手架迁移

```plantuml
@startuml
skinparam shadowing false
skinparam backgroundColor transparent
skinparam defaultTextAlignment center
skinparam ArrowColor #486581
skinparam rectangleBorderColor #486581
skinparam rectangleBackgroundColor #F0F4F8

rectangle "01  机械初始化\n项目名、品牌、仓库\n占位符替换" as Init #D9EAF7
rectangle "02  事实迁移\n定位、范围、非目标\n架构与未决项" as Truth
rectangle "03  工程对齐\n真实命令、契约\n依赖与可选模块" as Align
rectangle "04  环境验收\n本地门禁、CI\n部署与回滚证据" as Verify #D9EAD3

Init -right-> Truth
Truth -down-> Align
Align -left-> Verify
@enduml
```

![把通用脚手架迁移为真实项目的四个阶段](../../site-content/writing/ai-coding-scaffold-engineering-loop/assets/ai-scaffold-reuse-flow.svg)

## 脚手架演进

```plantuml
@startuml
left to right direction
skinparam shadowing false
skinparam backgroundColor transparent
skinparam defaultTextAlignment center
skinparam ArrowColor #486581
skinparam rectangleBorderColor #486581
skinparam rectangleBackgroundColor #F0F4F8

rectangle "基础模型能力提升" as Model #D9EAF7
rectangle "更薄的常驻规则\n只保留目标与不变量" as Thin
rectangle "更精准的上下文\n按任务检索事实与历史" as Context
rectangle "更长的验证闭环\n走到真实环境证据" as Verification
rectangle "基于评测的治理\n失败归因、去重、删旧" as Evaluation
rectangle "受控并行协作\n明确所有权与交付证据" as Collaboration
rectangle "始终保留\n项目事实、权限边界\n测试与可追溯证据" as Invariants #D9EAD3

Model --> Thin
Model --> Context
Model --> Verification
Model --> Evaluation
Model --> Collaboration

Thin --> Invariants
Context --> Invariants
Verification --> Invariants
Evaluation --> Invariants
Collaboration --> Invariants
@enduml
```

![基础模型能力提升后脚手架应变薄但不应移除的工程地基](../../site-content/writing/ai-coding-scaffold-engineering-loop/assets/ai-scaffold-evolution.svg)
