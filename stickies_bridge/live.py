"""Live mode: replays a learner session in real time and streams parameters to POST /input.

Each message carries the learner's position in the demo (``time``) as well as speed,
zoom and focus, so the tool's Live mode keeps the video where the learner is instead
of only matching their pace.

A streaming tracker's value for learner time t needs only samples up to t (+ the
tracker's lookahead), so computing the track up front and sending each value when its
moment comes is the same as running the tracker live. A value that needs a lookahead
is sent that much later and moved forward by the current pace.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

import numpy as np
import pandas as pd


def messages(samples: pd.DataFrame, latency_s: float, video: str | None = None, source: str | None = None):
    """Returns (first learner time, last learner time, function: learner time -> message without seq).

    `video` (the demo video's file name) is sent with every message, so the editor applies the
    values only while that video is open. `source` (e.g. "hmm · curls-x1.50") is shown in
    the editor's Live panel, so the viewer can see which tracker drives the video.
    """
    t = samples["t"].to_numpy(float)
    columns = {k: samples[k].to_numpy(float) for k in ("demo_s", "speed", "zoom", "x", "y")}

    def at(now: float) -> dict:
        known = now - latency_s  # the newest moment the tracker has reported
        v = {k: float(np.interp(known, t, col)) for k, col in columns.items()}
        return {
            "time": round(v["demo_s"] + v["speed"] * latency_s, 3),
            "speed": round(v["speed"], 3),
            "zoom": round(v["zoom"], 3),
            "x": round(v["x"], 2),
            "y": round(v["y"], 2),
            **({"video": video} if video else {}),
            **({"source": source[:80]} if source else {}),
        }

    return t[0], t[-1], at


def post(url: str, message: dict, timeout: float = 1.0) -> dict:
    request = urllib.request.Request(
        url, data=json.dumps(message).encode(), headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b"{}")


def stream(
    samples: pd.DataFrame,
    latency_s: float,
    url: str,
    rate_hz: float = 30.0,
    replay_speed: float = 1.0,
    loop: bool = False,
    dry_run: bool = False,
    log=print,
    video: str | None = None,
    source: str | None = None,
) -> int:
    start, end, at = messages(samples, latency_s, video, source)
    period = 1.0 / rate_hz
    seq, last_note = 0, 0.0
    log(f"Streaming {end - start:.1f} s of learner data to {url} at {rate_hz:g} Hz (Ctrl+C stops).")
    try:
        while True:
            began = time.monotonic()
            while True:
                elapsed = (time.monotonic() - began) * replay_speed
                now = start + elapsed
                if now > end:
                    break
                message = {"seq": seq, **at(now)}
                seq += 1
                if dry_run:
                    log(json.dumps(message))
                else:
                    try:
                        reply = post(url, message)
                        if time.monotonic() - last_note > 2:
                            last_note = time.monotonic()
                            listeners = reply.get("listeners", 0)
                            note = "" if listeners else "  (no page listening: open the tool and choose Live)"
                            log(f"  learner {now:6.2f} s -> demo {message['time']:6.2f} s, speed {message['speed']:.2f}x{note}")
                    except (urllib.error.URLError, OSError, ValueError) as exc:
                        if time.monotonic() - last_note > 2:
                            last_note = time.monotonic()
                            log(f"  cannot reach {url}: {exc}. Is `npm start` running?")
                time.sleep(max(0.0, period - (time.monotonic() - began - elapsed / replay_speed)))
            if not loop:
                break
            log("  restarting the session")
    except KeyboardInterrupt:
        log("Stopped.")
    return seq
