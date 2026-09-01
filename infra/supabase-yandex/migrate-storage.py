#!/usr/bin/env python3
"""Stream objects between Supabase Storage deployments and verify each copy."""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import quote, urlsplit


CHUNK_SIZE = 8 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 900


def emit(payload: dict[str, object]) -> None:
    print(json.dumps(payload), flush=True)


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def require_env(values: dict[str, str], key: str, env_path: Path) -> str:
    value = values.get(key, "").strip()
    if not value:
        raise RuntimeError(f"Missing {key} in {env_path}")
    return value


def run_psql(sql: str) -> str:
    result = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            "supabase-db",
            "psql",
            "-U",
            "supabase_admin",
            "-d",
            "postgres",
            "-At",
            "--set",
            "ON_ERROR_STOP=1",
        ],
        input=sql,
        text=True,
        check=True,
        capture_output=True,
    )
    return result.stdout


def load_objects(bucket: str, min_size: int, limit: int) -> list[dict[str, object]]:
    escaped_bucket = bucket.replace("'", "''")
    limit_sql = f"LIMIT {limit}" if limit > 0 else ""
    sql = f"""
SELECT json_build_object(
  'id', id::text,
  'name', name,
  'size', COALESCE(NULLIF(metadata->>'size', '')::bigint, 0),
  'mimetype', COALESCE(NULLIF(metadata->>'mimetype', ''), 'application/octet-stream'),
  'owner', owner::text,
  'owner_id', owner_id,
  'created_at', created_at::text,
  'updated_at', updated_at::text,
  'last_accessed_at', last_accessed_at::text,
  'user_metadata', user_metadata
)
FROM storage.objects
WHERE bucket_id = '{escaped_bucket}'
  AND COALESCE(NULLIF(metadata->>'size', '')::bigint, 0) >= {min_size}
ORDER BY COALESCE(NULLIF(metadata->>'size', '')::bigint, 0), id
{limit_sql};
"""
    return [json.loads(line) for line in run_psql(sql).splitlines() if line]


def connection_for(url: str) -> tuple[http.client.HTTPConnection, str]:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RuntimeError(f"Unsupported Supabase URL: {url}")
    connection_type = (
        http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    )
    connection = connection_type(
        parsed.hostname,
        parsed.port,
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    return connection, parsed.path.rstrip("/")


def object_path(base_path: str, bucket: str, name: str, authenticated: bool) -> str:
    route = "object/authenticated" if authenticated else "object"
    encoded_bucket = quote(bucket, safe="")
    encoded_name = quote(name, safe="/")
    return f"{base_path}/storage/v1/{route}/{encoded_bucket}/{encoded_name}"


def auth_headers(service_key: str) -> dict[str, str]:
    return {
        "apikey": service_key,
        "authorization": f"Bearer {service_key}",
        "user-agent": "lpmview-storage-migrator/1.0",
    }


def download_to_file(
    url: str,
    service_key: str,
    bucket: str,
    name: str,
    target_path: Path,
) -> tuple[int, str]:
    connection, base_path = connection_for(url)
    try:
        connection.request(
            "GET",
            object_path(base_path, bucket, name, authenticated=True),
            headers=auth_headers(service_key),
        )
        response = connection.getresponse()
        if response.status != 200:
            detail = response.read(4096).decode("utf-8", "replace")
            raise RuntimeError(f"Source download failed: HTTP {response.status}: {detail}")
        digest = hashlib.sha256()
        size = 0
        with target_path.open("wb") as output:
            while chunk := response.read(CHUNK_SIZE):
                output.write(chunk)
                digest.update(chunk)
                size += len(chunk)
        return size, digest.hexdigest()
    finally:
        connection.close()


def upload_file(
    url: str,
    service_key: str,
    bucket: str,
    name: str,
    source_path: Path,
    mimetype: str,
) -> None:
    connection, base_path = connection_for(url)
    size = source_path.stat().st_size
    try:
        connection.putrequest("POST", object_path(base_path, bucket, name, authenticated=False))
        for key, value in auth_headers(service_key).items():
            connection.putheader(key, value)
        connection.putheader("content-type", mimetype)
        connection.putheader("content-length", str(size))
        connection.putheader("x-upsert", "true")
        connection.endheaders()
        with source_path.open("rb") as source:
            while chunk := source.read(CHUNK_SIZE):
                connection.send(chunk)
        response = connection.getresponse()
        if response.status not in {200, 201}:
            detail = response.read(4096).decode("utf-8", "replace")
            raise RuntimeError(f"Target upload failed: HTTP {response.status}: {detail}")
        response.read()
    finally:
        connection.close()


def hash_remote_object(url: str, service_key: str, bucket: str, name: str) -> tuple[int, str]:
    connection, base_path = connection_for(url)
    try:
        connection.request(
            "GET",
            object_path(base_path, bucket, name, authenticated=True),
            headers=auth_headers(service_key),
        )
        response = connection.getresponse()
        if response.status != 200:
            detail = response.read(4096).decode("utf-8", "replace")
            raise RuntimeError(f"Target verification failed: HTTP {response.status}: {detail}")
        digest = hashlib.sha256()
        size = 0
        while chunk := response.read(CHUNK_SIZE):
            digest.update(chunk)
            size += len(chunk)
        return size, digest.hexdigest()
    finally:
        connection.close()


def restore_ownership_and_timestamps(row: dict[str, object]) -> None:
    payload = json.dumps(row, ensure_ascii=True, separators=(",", ":")).replace("'", "''")
    sql = f"""
WITH source AS (SELECT '{payload}'::jsonb AS value)
UPDATE storage.objects AS object
SET owner = NULLIF(source.value->>'owner', '')::uuid,
    owner_id = source.value->>'owner_id',
    created_at = NULLIF(source.value->>'created_at', '')::timestamptz,
    updated_at = NULLIF(source.value->>'updated_at', '')::timestamptz,
    last_accessed_at = NULLIF(source.value->>'last_accessed_at', '')::timestamptz,
    user_metadata = source.value->'user_metadata'
FROM source
WHERE object.id = (source.value->>'id')::uuid;
"""
    run_psql(sql)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-env", type=Path, required=True)
    parser.add_argument("--target-env", type=Path, required=True)
    parser.add_argument("--target-url", default="http://127.0.0.1:8000")
    parser.add_argument("--bucket", default="models")
    parser.add_argument("--min-size", type=int, default=0)
    parser.add_argument("--max-objects", type=int, default=0)
    parser.add_argument("--temp-dir", type=Path, default=Path("/var/tmp"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source_env = read_env(args.source_env)
    target_env = read_env(args.target_env)
    source_url = require_env(source_env, "SUPABASE_URL", args.source_env)
    source_key = require_env(source_env, "SUPABASE_SERVICE_ROLE_KEY", args.source_env)
    target_key = require_env(target_env, "SERVICE_ROLE_KEY", args.target_env)
    objects = load_objects(args.bucket, args.min_size, args.max_objects)
    total_bytes = sum(int(row["size"]) for row in objects)
    emit({"objects": len(objects), "bytes": total_bytes, "status": "starting"})

    migrated_bytes = 0
    for index, row in enumerate(objects, start=1):
        expected_size = int(row["size"])
        object_id = str(row["id"])
        name = str(row["name"])
        mimetype = str(row["mimetype"])
        temp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                prefix="lpmview-storage-",
                dir=args.temp_dir,
                delete=False,
            ) as temp_file:
                temp_path = Path(temp_file.name)
            source_size, source_hash = download_to_file(
                source_url,
                source_key,
                args.bucket,
                name,
                temp_path,
            )
            if source_size != expected_size:
                raise RuntimeError(
                    f"Source size mismatch for {object_id}: expected {expected_size}, got {source_size}"
                )
            upload_file(
                args.target_url,
                target_key,
                args.bucket,
                name,
                temp_path,
                mimetype,
            )
            target_size, target_hash = hash_remote_object(
                args.target_url,
                target_key,
                args.bucket,
                name,
            )
            if (target_size, target_hash) != (source_size, source_hash):
                raise RuntimeError(f"Target checksum mismatch for {object_id}")
            restore_ownership_and_timestamps(row)
            migrated_bytes += target_size
            emit(
                {
                    "index": index,
                    "objects": len(objects),
                    "object_id": object_id,
                    "bytes": target_size,
                    "migrated_bytes": migrated_bytes,
                    "status": "verified",
                }
            )
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)

    emit({"objects": len(objects), "bytes": migrated_bytes, "status": "complete"})


if __name__ == "__main__":
    main()
