"""Dump the database for the backup workflow, reading the address from DATABASE_URL.

The address is split here and handed over as separate settings, so a password containing @ : / or #
works, and it can't appear in a pg_dump error message (workflow logs are public).
"""

import os
import subprocess
import sys
from urllib.parse import unquote


def connection_settings(url):
    rest = url.split("://", 1)[-1]
    credentials, _, location = rest.rpartition("@")  # the last @ ends the password
    user, _, password = credentials.partition(":")
    server, _, database = location.partition("/")
    database, _, options = database.partition("?")
    host, _, port = server.partition(":")
    settings = {
        "PGUSER": unquote(user),
        "PGPASSWORD": unquote(password),
        "PGHOST": host,
        "PGPORT": port or "5432",
        "PGDATABASE": database or "postgres",
        "PGSSLMODE": "require",
    }
    if "sslmode=disable" in options:  # only ever a local test
        settings["PGSSLMODE"] = "disable"
    return settings


def main(path):
    settings = connection_settings(os.environ["DATABASE_URL"])
    command = ["pg_dump", "--schema=public", "--format=custom", "--no-owner", "--no-privileges", f"--file={path}"]
    return subprocess.run(command, env={**os.environ, **settings, "DATABASE_URL": ""}).returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
