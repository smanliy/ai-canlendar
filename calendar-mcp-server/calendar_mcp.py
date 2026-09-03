from pathlib import Path
import runpy

runpy.run_path(str(Path(__file__).resolve().parent / ".venv" / "calendar_mcp.py"), run_name="__main__")
