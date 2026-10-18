"""The discovery service: the papers MCP and the pipeline behind it.

Importing the package loads the nearest `.env` above it, keeping variables
already set in the environment.
"""

from pathlib import Path

from dotenv import load_dotenv

for _folder in Path(__file__).resolve().parents:
    if (_folder / ".env").is_file():
        load_dotenv(_folder / ".env", override=False)
        break
