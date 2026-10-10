"""Create (or revoke) the token an agent uses to write through the API.

    python scripts/make_token.py maki
    python scripts/make_token.py maki --revoke

The token is printed once and never stored: only its SHA-256 goes into the
per-machine config outside Drive (%LOCALAPPDATA%/EmbraceDashboard/config.json).
Creating a token for a name that already has one replaces it. Restart the
server afterwards.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import auth  # noqa: E402
import config  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("name", help="the Actor name recorded in the audit log, e.g. maki")
    ap.add_argument("--revoke", action="store_true")
    args = ap.parse_args()
    name = args.name.strip().lower()
    if name == auth.BEST:
        sys.exit("'best' is the dashboard page itself and cannot have a token")

    local = config.read_local()
    tokens = [t for t in local.get("agent_tokens", []) if t.get("name") != name]
    if args.revoke:
        local["agent_tokens"] = tokens
        config.write_local(local)
        print(f"revoked token for {name}. Restart the server.")
        return
    token = auth.new_token()
    local["agent_tokens"] = tokens + [{"name": name, "sha256": auth.hash_token(token)}]
    config.write_local(local)
    print(f"token for {name} (shown once, store it in the agent's own secrets):\n\n{token}\n")
    print(f"saved hash to {config.local_config_path()}. Restart the server.")


if __name__ == "__main__":
    main()
