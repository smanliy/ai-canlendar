from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "docs" / "python-agent-flow.mmd"


FLOW = """flowchart TD
    start([HTTP request]) --> server["app/main.py<br/>run_server()"]
    server --> handler["agent/server.py<br/>AgentHandler.do_GET / do_POST"]
    handler --> routes{"agent/routes.py<br/>handle_get / handle_post"}

    routes -->|GET /health| health["return status, pid, file"]

    routes -->|POST /agent/validate| validate["validators.validate_fields()"]
    validate --> validateInput["merge rawInput + llmExtraction + clarificationJson"]
    validateInput --> validateDecision{"duration + deadline ISO complete?"}
    validateDecision -->|no| needsInput["status=needsUserInput<br/>clarificationJson"]
    validateDecision -->|yes| validateReady["status=ready<br/>normalizedContext"]

    routes -->|POST /agent/plan| plan["planner.plan_atomic_tasks()"]
    plan --> research["tools.research_task_duration()"]
    research --> searchProviders["web search providers<br/>CSTCloud / Tavily / DuckDuckGo"]
    searchProviders --> evidenceDecision{"external evidence found?"}
    evidenceDecision -->|no| planFailed["return structured failed payload"]
    evidenceDecision -->|yes| deepseekPlan["_call_deepseek_for_atomic_tasks()"]
    deepseekPlan --> normalizeTasks["_normalize_atomic_tasks()"]
    normalizeTasks --> enrichEvidence["enrich_atomic_task_evidence()"]
    enrichEvidence --> calendarQuery["query_existing_calendar_events()<br/>tools.calendar_events_query()"]
    calendarQuery --> freeWindows["calculate_available_free_windows()<br/>tools.calculate_free_windows()"]
    freeWindows --> schedule["tools.schedule_tasks()"]
    schedule --> attachNote["_attach_excluded_availability_note()"]
    attachNote --> conflictCheck["_check_conflicts_after_schedule()<br/>tools.check_schedule_conflicts()"]
    conflictCheck --> feasibility["validate_atomic_plan()"]
    feasibility --> planResponse["return atomicTasks + feasibility<br/>toolResults + schedule/conflict results"]

    routes -->|POST /agent/resume| resume["planner.resume_schedule_decision()"]
    resume --> resumeDecision{"decision.optionId"}
    resumeDecision -->|allow_beyond_golden_time| allowSchedule["schedule_tasks(decisions=allow beyond golden time)"]
    allowSchedule --> allowConflict["check conflicts"]
    allowConflict --> resumeReady["return status=ready"]
    resumeDecision -->|split_task| findParent["_find_task_by_id_or_title()"]
    findParent --> splitMode{"can auto split?"}
    splitMode -->|LLM split| llmSplit["_split_single_task_with_llm()"]
    splitMode -->|fallback/mechanical| mechanicalSplit["_split_single_task_mechanically()<br/>or _fallback_split_parent_task()"]
    llmSplit --> replaceTask["_replace_one_task_only()"]
    mechanicalSplit --> replaceTask
    replaceTask --> reschedule["schedule_tasks()"]
    reschedule --> resumeConflict["check conflicts"]
    resumeConflict --> splitResponse["return updated atomicTasks<br/>schedule/conflict results"]
    resumeDecision -->|other| unsupported["return status=unsupported"]

    routes -->|POST /agent/tool-agent| toolAgent["tool_agent.run_tool_agent()"]
    toolAgent --> selectTools["DeepSeek selects toolCalls"]
    selectTools --> dispatch["tools.dispatch_tool_call()"]
    dispatch --> finalAnswer["DeepSeek final answer from toolResults"]
    finalAnswer --> toolResponse["return answer + toolCalls + toolResults"]

    routes -->|POST /agent/tasks| tasks["executor.accept_task()"]
    tasks --> finalValidate["validate_final_task()"]
    finalValidate --> taskResponse["return received payload + finalValidation"]

    routes -->|unknown path| notFound["404 Not found"]
"""


HTML_TEMPLATE = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Python Agent Flow</title>
  <style>
    body {{
      margin: 0;
      padding: 24px;
      font-family: Arial, "Microsoft YaHei", sans-serif;
      background: #f7f8fa;
      color: #1f2937;
    }}
    h1 {{
      margin: 0 0 16px;
      font-size: 22px;
      font-weight: 700;
    }}
    .wrap {{
      overflow: auto;
      background: #fff;
      border: 1px solid #d8dee8;
      border-radius: 8px;
      padding: 16px;
    }}
  </style>
</head>
<body>
  <h1>Python Agent Flow</h1>
  <div class="wrap">
    <pre class="mermaid">
{flow}
    </pre>
  </div>
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
    mermaid.initialize({{ startOnLoad: true, theme: "default", securityLevel: "loose" }});
  </script>
</body>
</html>
"""


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def render_with_mmdc(source: Path, target: Path) -> bool:
    executable = shutil.which("mmdc")
    if not executable:
        return False
    subprocess.run([executable, "-i", str(source), "-o", str(target)], check=True)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Render the Python agent flow as Mermaid and optional SVG.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT, help="Mermaid output path.")
    parser.add_argument("--svg", type=Path, default=None, help="Optional SVG output path rendered with mmdc.")
    args = parser.parse_args()

    write_text(args.out, FLOW)
    html_path = args.out.with_suffix(".html")
    write_text(html_path, HTML_TEMPLATE.format(flow=FLOW))

    rendered = False
    if args.svg:
        args.svg.parent.mkdir(parents=True, exist_ok=True)
        rendered = render_with_mmdc(args.out, args.svg)

    print(f"Mermaid: {args.out}")
    print(f"HTML: {html_path}")
    if args.svg:
        print(f"SVG: {args.svg if rendered else 'skipped, mmdc not found'}")


if __name__ == "__main__":
    main()
