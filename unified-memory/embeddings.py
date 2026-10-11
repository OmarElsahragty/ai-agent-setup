import json, time, urllib.request
from config import EMBED_URL, EMBED_MODEL

_BATCH_SIZE = 32  # texts per single HTTP request (llama-server batch input)


def embed(text: str, max_retries: int = 3) -> list:
    """Embed a single text string with automatic retry on boot/warmup delays."""
    text = text[:4000]
    data = json.dumps({"model": EMBED_MODEL, "input": text}).encode()
    
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(
                EMBED_URL, data=data, headers={"Content-Type": "application/json"}
            )
            resp = urllib.request.urlopen(req, timeout=30)
            return json.loads(resp.read())["data"][0]["embedding"]
        except Exception as e:
            if attempt == max_retries - 1:
                print(f"Embed request failed after {max_retries} attempts: {e}", flush=True)
                raise
            time.sleep(1.0)


def embed_batch(texts: list, max_workers: int = 4) -> list:
    """Embed multiple texts using batch input API (single HTTP request per group).

    The llama-server processes batch input internally with optimal thread usage,
    avoiding the 10-50x slowdown from concurrent HTTP requests competing for
    the same CPU threads (--threads 3).
    """
    results = []
    for i in range(0, len(texts), _BATCH_SIZE):
        chunk = [t[:4000] for t in texts[i:i + _BATCH_SIZE]]
        batch_res = None
        for attempt in range(3):
            try:
                data = json.dumps({"model": EMBED_MODEL, "input": chunk}).encode()
                req = urllib.request.Request(
                    EMBED_URL, data=data, headers={"Content-Type": "application/json"}
                )
                resp = urllib.request.urlopen(req, timeout=60)
                batch_data = json.loads(resp.read())["data"]
                batch_res = [d["embedding"] for d in batch_data]
                break
            except Exception as e:
                print(f"Batch embed attempt {attempt+1} error: {e}", flush=True)
                time.sleep(1.0)

        if batch_res is not None:
            results.extend(batch_res)
        else:
            results.extend([None] * len(chunk))
    return results

