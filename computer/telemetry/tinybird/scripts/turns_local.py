"""Run Tinybird pipes over NDJSON events in a local ClickHouse (chdb), to check
the SQL that derives turns before `tb build` (work 054). Each datasource is a
table from its .datasource schema; each pipe node becomes a view, in order.
`endpoint()` renders an endpoint's template nodes with given parameters
(Tornado, as Tinybird does) and returns its rows (work 084).

  python3 -m venv /tmp/ch && /tmp/ch/bin/pip install chdb tornado
  /tmp/ch/bin/python -I turns_local.py events.ndjson "SELECT * FROM turns" [legacy-turns.ndjson]
"""
import pathlib
import re
import sys

from chdb import session

ROOT = pathlib.Path(__file__).resolve().parent.parent


def schema(path: pathlib.Path) -> str:
    text = path.read_text()
    block = text.split("SCHEMA >", 1)[1].split("\n\n", 1)[0]
    cols = [re.sub(r"\s*`json:[^`]*`", "", line.strip().rstrip(",")) for line in block.strip().splitlines()]
    return ", ".join(cols)


def nodes(path: pathlib.Path):
    text = path.read_text()
    for part in re.split(r"^NODE ", text, flags=re.M)[1:]:
        name = part.split("\n", 1)[0].strip()
        sql = part.split("SQL >", 1)[1]
        sql = re.split(r"^(TYPE|NODE|TOKEN) ", sql, flags=re.M)[0]
        yield name, "\n".join(line[4:] if line.startswith("    ") else line for line in sql.splitlines()).strip()


def load(events: str, legacy: str | None = None) -> session.Session:
    s = session.Session()
    s.query("CREATE DATABASE IF NOT EXISTS tb_local ENGINE = Atomic")
    s.query("USE tb_local")
    s.query(f"CREATE TABLE calvin_events ({schema(ROOT / 'datasources' / 'calvin_events.datasource')}) ENGINE = Memory")
    s.query(f"INSERT INTO calvin_events SELECT * FROM file('{events}', 'JSONEachRow') SETTINGS input_format_skip_unknown_fields = 1")
    s.query(f"CREATE TABLE calvin_turns ({schema(ROOT / 'datasources' / 'calvin_turns.datasource')}) ENGINE = Memory")
    if legacy:
        s.query(f"INSERT INTO calvin_turns SELECT * FROM file('{legacy}', 'JSONEachRow') SETTINGS input_format_skip_unknown_fields = 1")
    for pipe in sorted((ROOT / "pipes").glob("*.pipe")):
        for name, sql in nodes(pipe):
            try:
                s.query(f"CREATE VIEW {name} AS {sql}")
            except Exception as e:
                sys.exit(f"{pipe.name} NODE {name}: {str(e).split(' In scope')[0][:600]}")
        s.query(f"CREATE VIEW {pipe.stem} AS SELECT * FROM {name}") if name != pipe.stem else None
    return s


def render(sql: str, params: dict) -> str:
    """A Tinybird template node with `params`; the subset of its functions our endpoints use."""
    if not sql.startswith("%"):
        return sql
    from tornado import template

    body = sql[1:]
    names = set(re.findall(r"defined\((\w+)\)", body)) | set(re.findall(r"\b(?:DateTime|String|Int32|Float64|column)\((\w+)", body))

    def quote(v, default=None, required=False, **_):
        v = default if v is None else v
        if v is None:
            raise ValueError("a required parameter is missing")
        return "'" + str(v).replace("\\", "\\\\").replace("'", "\\'") + "'"

    def number(kind):
        return lambda v, default=None, **_: str(kind(v if v is not None else default))

    def error(message, code=400):
        raise ValueError(f"{code}: {message}")

    ns = {n: params.get(n) for n in names}
    ns.update(
        defined=lambda v: v is not None,
        DateTime=quote,
        String=quote,
        Int32=number(int),
        Float64=number(float),
        column=lambda v, default=None: v if v is not None else default,
        error=error,
    )
    return template.Template(body, autoescape=None).generate(**ns).decode()


def endpoint(s: session.Session, name: str, params: dict) -> list[dict]:
    """An endpoint's rows over the loaded events: each node a view (replaced per call), the last one queried."""
    import json

    last = None
    for node, sql in nodes(ROOT / "endpoints" / f"{name}.pipe"):
        try:
            s.query(f"CREATE OR REPLACE VIEW {node} AS {render(sql, params)}")
        except Exception as e:
            raise SystemExit(f"{name}.pipe NODE {node}: {str(e).split(' In scope')[0][:800]}")
        last = node
    out = s.query(f"SELECT * FROM {last}", "JSONEachRow").bytes().decode()
    return [json.loads(line) for line in out.splitlines()]


def main(events: str, query: str, legacy: str | None = None):
    print(load(events, legacy).query(query, "PrettyCompactNoEscapes"))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
