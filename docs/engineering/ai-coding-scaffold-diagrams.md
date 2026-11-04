# AI 编码脚手架文章图表源

状态：active
最近更新：2026-11-04
适用范围：Scaffold 项目介绍与技术文章的静态示意图

本文件是图表的唯一可编辑源码，依据公开 `project-scaffold@4fc47cf` 与本轮本地核对记录。
图表示意职责和控制路径，不作为实机演示或执行成功证明。
本地使用 PlantUML 编译 SVG；公开页只加载静态图片，不运行图表插件。
每段源码紧跟其目标 SVG，使用既有 `scripts/quality/render-diagrams.mjs` 生成。

## 项目职责架构

```plantuml
@startuml
top to bottom direction
skinparam shadowing false
skinparam backgroundColor #FAF8F2
skinparam defaultFontName "SansSerif"
skinparam defaultFontSize 18
skinparam defaultTextAlignment center
skinparam ArrowColor #486581
skinparam rectangleBorderColor #486581
skinparam rectangleBackgroundColor #F0F4F8
skinparam nodesep 20
skinparam ranksep 30

rectangle "目标项目\nREADME / docs / build\n项目介绍、决定与产物" as Project #D9EAF7
rectangle "脚手架资料\nSCAFFOLD / scaffold\n模板设计、初始化与维护" as Scaffold #FBE5D6
rectangle "规则与日常工具\nAgent 入口 / 任务规则\nscripts / Git hooks" as Tools
rectangle "确定性检查\nquality / 布局回归\n文档、契约与 CI/CD 边界" as Checks
rectangle "独立环境证据\n实际 CI / 业务测试\n部署与恢复验收" as Real #D9EAD3

Project -down-> Scaffold : 区分所有权
Scaffold -down-> Tools : 提供机制
Project -right-> Tools : 提供项目事实
Tools -down-> Checks : 执行验证
Checks -down-> Real : 本地通过后仍需验证
@enduml
```

![项目与脚手架资料、工具和环境证据的职责架构](../../site-content/projects/vibecoding-project-scaffold/assets/scaffold-architecture.svg)

## 上下文与执行职责

```plantuml
@startuml
top to bottom direction
skinparam shadowing false
skinparam backgroundColor #FAF8F2
skinparam defaultFontName "SansSerif"
skinparam defaultFontSize 18
skinparam defaultTextAlignment center
skinparam ArrowColor #486581
skinparam rectangleBorderColor #486581
skinparam rectangleBackgroundColor #F0F4F8
skinparam ranksep 30

rectangle "项目负责人\n目标、关键取舍与授权" as Owner #D9EAF7
rectangle "项目文档 docs/\n当前事实、决定与未决项" as Docs
rectangle "Agent 上下文\n根规则 → 任务规则 → Skill\n根据任务读取所需内容" as Context
rectangle "任务执行\n修改代码 / 调用脚本\n保留检查结果" as Execution
rectangle "反馈与收尾\n结果、局限和下一步\n回写对应作用域进度" as Evidence #D9EAD3

Owner -down-> Docs : 确认并记录
Docs -down-> Context : 读取事实
Context -down-> Execution : 指导执行
Execution -down-> Evidence : 验证与说明
@enduml
```

![项目事实进入 Agent 上下文并形成反馈证据的关系](../../site-content/writing/ai-coding-scaffold-engineering-loop/assets/ai-scaffold-layers.svg)

## 规范要求的单次任务流程

```plantuml
@startuml
skinparam shadowing false
skinparam backgroundColor #FAF8F2
skinparam defaultFontName "SansSerif"
skinparam defaultFontSize 18
skinparam ArrowColor #486581
skinparam activityBackgroundColor #F0F4F8
skinparam activityBorderColor #486581

start
:查阅实际文件与已有授权;
if (存在缺失的用户决定？) then (是)
  :暂停依赖工作\n说明事实、选项与影响;
  :由用户确认决定;
else (否)
endif
:更新负责该事项的设计;
:实施可审查的改动;
while (适用检查未通过？) is (是)
  :保留失败证据\n定位并修复问题;
endwhile (否)
:报告结果与未覆盖范围;
stop
@enduml
```

![任务规范中的决策、实施与验证循环](../../site-content/writing/ai-coding-scaffold-engineering-loop/assets/ai-scaffold-task-loop.svg)

## 初始化写入边界

```plantuml
@startuml
skinparam shadowing false
skinparam backgroundColor #FAF8F2
skinparam defaultFontName "SansSerif"
skinparam defaultFontSize 18
skinparam ArrowColor #486581
skinparam activityBackgroundColor #F0F4F8
skinparam activityBorderColor #486581

start
:读取初始化文件清单;
if (路径与文件均合法？) then (否)
  :拒绝清单\n不进入项目替换;
  stop
else (是)
endif
:收集项目与可选功能输入;
:仅替换目标清单文件\n保留 scaffold/ 资料;
:按选择写本地配置\n或待决策记录;
:运行 quality;
if (检查通过？) then (是)
  :审查初始化结果;
else (否)
  :保留失败\n查看 diff 并修复;
endif
stop
@enduml
```

![初始化清单校验与后置质量检查流程](../../site-content/writing/ai-coding-scaffold-engineering-loop/assets/ai-scaffold-reuse-flow.svg)

## CI/CD 配置与验收

```plantuml
@startuml
top to bottom direction
skinparam shadowing false
skinparam backgroundColor #FAF8F2
skinparam defaultFontName "SansSerif"
skinparam defaultFontSize 18
skinparam defaultTextAlignment center
skinparam ArrowColor #486581
skinparam rectangleBorderColor #486581
skinparam rectangleBackgroundColor #F0F4F8
skinparam ranksep 28

rectangle "探测项目与 GitHub 事实\nprobe → .cicd/probe.json\n本地快照不提交" as Probe #D9EAF7
rectangle "负责人确认命令与目标\n决策账本 cicd-answers.json\n进入 Git 审核" as Ledger
rectangle "生成受管理配置\nrender → workflow / 配置\n预检、替换与失败恢复" as Render
rectangle "检查配置\n漂移 / 所有权 / 发布守卫\n本地反例与边界 fixture" as Checks
rectangle "独立远端验收\n精确提交的 CI 与发布证据\n目标项目恢复方法" as Remote #D9EAD3

Probe -down-> Ledger : 事实提供依据
Ledger -down-> Render : 决定拥有配置
Render -down-> Checks : 验证生成结果
Checks -down-> Remote : 需另行执行与授权
@enduml
```

![CI/CD 事实、决策、生成物与远端验收的单向关系](../../site-content/writing/ai-coding-scaffold-engineering-loop/assets/ai-scaffold-evolution.svg)
