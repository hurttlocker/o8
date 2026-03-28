#!/usr/bin/env python3
import json
import sqlite3
import struct
import sys
import urllib.request


def zero_vector_blob(dimensions: int) -> bytes:
    return struct.pack(f"{dimensions}f", *([0.0] * dimensions))


def main() -> int:
    if len(sys.argv) != 4:
      print("usage: embed_with_timeout.py <db_path> <model> <timeout_seconds>", file=sys.stderr)
      return 1

    db_path = sys.argv[1]
    model = sys.argv[2]
    timeout_seconds = float(sys.argv[3])

    conn = sqlite3.connect(db_path)
    conn.execute("DELETE FROM embeddings")
    conn.commit()

    rows = conn.execute(
        "SELECT id, content FROM memories ORDER BY id ASC"
    ).fetchall()

    done = 0
    failures = 0

    for memory_id, content in rows:
        try:
            payload = json.dumps(
                {
                    "model": model,
                    "prompt": (content or "")[:2000],
                }
            ).encode()
            request = urllib.request.Request(
                "http://localhost:11434/api/embeddings",
                data=payload,
                headers={"Content-Type": "application/json"},
            )
            response = urllib.request.urlopen(request, timeout=timeout_seconds).read()
            embedding = json.loads(response).get("embedding")
            if embedding:
                blob = struct.pack(f"{len(embedding)}f", *embedding)
                conn.execute(
                    "INSERT OR REPLACE INTO embeddings (memory_id, vector, dimensions) VALUES (?, ?, ?)",
                    (memory_id, blob, len(embedding)),
                )
                conn.commit()
                done += 1
                continue
        except Exception:
            failures += 1

        blob = zero_vector_blob(384)
        conn.execute(
            "INSERT OR REPLACE INTO embeddings (memory_id, vector, dimensions) VALUES (?, ?, ?)",
            (memory_id, blob, 384),
        )
        conn.commit()

    print(f"{done}/{len(rows)} embedded; failures={failures}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
