"""Command line: python3 -m stickies_bridge <timeline|live|evaluate|pose> ..."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

import numpy as np

from .parameters import Mapping, parameter_samples
from .pose import FOCUS_PARTS, extract_pose, load_focus
from .session import BridgeError, load_session
from .timeline import build_timeline
from .trackers import ROOT, STREAMING, TRACKERS, algorithms_dir, run_tracker, tracking_error

OUTPUT_DIR = ROOT / "output" / "stickies"
MIN_MOTION_DEG = 30.0  # a demo segment moving less than this (5th-95th percentile) cannot be tracked
DEFAULT_URL = f"http://127.0.0.1:{os.environ.get('PORT', 4173)}/input"


def _param(text: str):
    if "=" not in text:
        raise argparse.ArgumentTypeError(f"expected NAME=VALUE, got {text!r}")
    key, value = text.split("=", 1)
    try:
        return key, json.loads(value)
    except ValueError:
        return key, value


def _number(lo: float, hi: float, lo_open: bool = False):
    """argparse type: a float in [lo, hi] ((lo, hi] when lo_open), rejected with a message otherwise."""

    def parse(text: str) -> float:
        try:
            value = float(text)
        except ValueError:
            raise argparse.ArgumentTypeError(f"expected a number, got {text!r}") from None
        if not (lo < value <= hi if lo_open else lo <= value <= hi):
            raise argparse.ArgumentTypeError(f"must be {'above' if lo_open else 'at least'} {lo:g} and at most {hi:g}")
        return value

    return parse


def _add_session_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("session", help="learner folder with stickies.csv (e.g. .../dummy_data/curls/x1.50)")
    p.add_argument("--reference", help="demo MediaPipe angles (default: reference.csv next to the session)")
    p.add_argument("--video", help="demo video (default: from reference.json)")
    p.add_argument("--segment", help="body segment to track (default: right_forearm_elev_deg)")
    p.add_argument("--algorithms", help="Video-Sticky-Algorithms folder (default: vendor/Video-Sticky-Algorithms)")
    p.add_argument("--param", type=_param, action="append", default=[], metavar="NAME=VALUE",
                   help="tracker hyperparameter, e.g. --param particles=500 (repeatable)")


def _add_mapping_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--tracker", choices=TRACKERS, default="gvf", help="default: gvf")
    p.add_argument("--pose", default="auto",
                   help="demo landmarks for focus: a CSV from the `pose` command, 'auto' (extract and cache), or 'none'")
    p.add_argument("--focus-on", choices=sorted(FOCUS_PARTS), default="forearm")
    p.add_argument("--side", choices=("right", "left"), default="right")
    p.add_argument("--zoom", type=_number(1, 5), help="steady zoom, 1-5 (default 1.6 with pose, 1 without)")
    p.add_argument("--error-zoom", type=_number(0, 180, lo_open=True), metavar="DEG",
                   help="zoom to --zoom-max while the learner's angle is this far from the demo's")
    p.add_argument("--zoom-max", type=_number(1, 5), default=2.5)
    p.add_argument("--pace-window", type=_number(0.2, 30), default=2.0,
                   help="seconds of movement per speed value (0.2-30)")


def _focus(args, session, algorithms, out_dir: Path, log):
    if args.pose == "none":
        return None
    if args.pose != "auto":
        pose = Path(args.pose).expanduser()
        if not pose.is_file():
            raise BridgeError(f"Pose file not found: {pose} (use --pose auto, --pose none, or a CSV from the pose command).")
        return load_focus(pose, args.focus_on)
    if session.video is None:
        log("No demo video found, so no focus: pass --video, or --pose none to silence this.")
        return None
    cache = out_dir / f"{session.video.stem}_{args.side}_pose.csv"
    if not cache.exists() or cache.stat().st_mtime < session.video.stat().st_mtime:
        log(f"Extracting {args.side}-side pose from {session.video.name} (cached in {cache}) ...")
        extract_pose(session.video, cache, algorithms_dir(algorithms), args.side, log)
    return load_focus(cache, args.focus_on)


def _prepare(args, causal: bool, log=print):
    session = load_session(args.session, args.reference, args.video, args.segment)
    out_dir = Path(getattr(args, "out", None) or OUTPUT_DIR / session.name)
    out_dir.mkdir(parents=True, exist_ok=True)
    log(f"Session {session.name}: {session.learner_t[-1] - session.learner_t[0]:.1f} s of learner data, "
        f"demo {session.demo_duration:.1f} s, segment {session.segment}")
    motion = float(np.subtract(*np.percentile(session.reference_angle, [95, 5])))
    if motion < MIN_MOTION_DEG:
        log(f"Warning: {session.segment} moves only {motion:.0f}° in the demo, too little to track "
            f"reliably. Choose a moving segment with --segment.")
    if causal and args.tracker not in STREAMING:
        log(f"Note: {args.tracker} uses the whole recording (future samples); live, use gvf or dtw-online.")
    track = run_tracker(args.tracker, session, dict(args.param), args.algorithms)
    error = tracking_error(track, session)
    if error:
        log(f"Tracker {track.tracker}: position error vs truth.csv  MAE {error['mae_s']} s, "
            f"p90 {error['p90_s']} s, max {error['max_s']} s")
    focus = _focus(args, session, args.algorithms, OUTPUT_DIR, log)
    mapping = Mapping(pace_window_s=args.pace_window, zoom=args.zoom, error_zoom_deg=args.error_zoom,
                      zoom_max=args.zoom_max)
    samples = parameter_samples(track, session, focus, mapping, causal=causal)
    return session, track, error, focus, samples, out_dir


def _videos_dir() -> Path:
    return Path(os.environ.get("VIDEOS_DIR") or ROOT / "videos")


def _install_video(video: Path, log) -> None:
    target_dir = _videos_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / video.name
    if target.exists():
        if target.stat().st_size == video.stat().st_size:
            log(f"{video.name} is already in {target_dir}.")
        else:
            log(f"A different {video.name} is already in {target_dir}; left it alone. Import the video by hand.")
        return
    shutil.copy2(video, target)
    log(f"Copied {video.name} into {target_dir} (the tool's video library).")


def cmd_timeline(args) -> int:
    session, track, error, focus, samples, out_dir = _prepare(args, causal=False)
    video_name = session.video.name if session.video else None
    name = f"Stickies {track.tracker} · {session.name}"
    data = build_timeline(samples, session.demo_duration, video_name, name, args.cue_step, focus, args.error_zoom)
    timeline_path = out_dir / f"{session.name}_{track.tracker}.json"
    samples_path = out_dir / f"{session.name}_{track.tracker}_samples.csv"
    report_path = out_dir / f"{session.name}_{track.tracker}_report.json"
    timeline_path.write_text(json.dumps(data, indent=2) + "\n")
    samples.to_csv(samples_path, index=False, float_format="%.4f")
    report = {
        "session": session.name, "tracker": track.tracker, "segment": session.segment,
        "video": video_name, "cues": len(data["preset"]["cues"]), "tracking_error_vs_truth": error,
        "focus": args.focus_on if focus is not None else None,
        "speed": {"min": round(float(samples.speed.min()), 2), "median": round(float(samples.speed.median()), 2),
                  "max": round(float(samples.speed.max()), 2)},
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    if args.install and session.video:
        _install_video(session.video, print)
    print(f"\nCue timeline: {timeline_path}  ({len(data['preset']['cues'])} cues)")
    print(f"Samples:      {samples_path}")
    print(f"Report:       {report_path}")
    print("\nIn the tool (npm start): Import -> choose the JSON"
          + (f" (it opens {video_name} from the library)" if video_name else "")
          + ", choose Cues under Control, press Play. Export -> Video records the adaptive video.")
    return 0


def cmd_live(args) -> int:
    from .live import stream  # noqa: PLC0415

    session, track, _error, _focus, samples, _out = _prepare(args, causal=True)
    if args.install and session.video:
        _install_video(session.video, print)
    if session.video:
        print(f"In the tool: open {session.video.name}, choose Live under Control and press Play.")
    video = session.video.name if session.video else None
    stream(samples, track.latency_s, args.url, args.rate, args.replay_speed, args.loop, args.dry_run,
           video=video, source=f"{track.tracker} · {session.name}")
    return 0


def cmd_evaluate(args) -> int:
    session = load_session(args.session, args.reference, args.video, args.segment)
    if session.truth is None:
        raise BridgeError("evaluate needs truth.csv (dummy data).")
    print(f"{session.name}: learner position error vs truth.csv (seconds of demo video)")
    print(f"  {'tracker':<11} {'MAE':>6} {'p90':>6} {'max':>6}")
    for name in args.trackers or [t for t in TRACKERS if t != "truth"]:
        error = tracking_error(run_tracker(name, session, dict(args.param), args.algorithms), session)
        print(f"  {name:<11} {error['mae_s']:>6.2f} {error['p90_s']:>6.2f} {error['max_s']:>6.2f}")
    return 0


def cmd_pose(args) -> int:
    video = Path(args.video).expanduser().resolve()
    out = Path(args.out) if args.out else OUTPUT_DIR / f"{video.stem}_{args.side}_pose.csv"
    extract_pose(video, out, algorithms_dir(args.algorithms), args.side)
    print(f"Pose: {out}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python3 -m stickies_bridge", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("timeline", help="learner session -> cue timeline JSON for the tool (offline)")
    _add_session_args(p)
    _add_mapping_args(p)
    p.add_argument("--cue-step", type=_number(0.05, 60), default=0.5, help="seconds of demo per cue before merging")
    p.add_argument("--out", help=f"output folder (default: {OUTPUT_DIR.relative_to(ROOT)}/<session>)")
    p.add_argument("--install", action="store_true", help="copy the demo video into the tool's videos/ folder")
    p.set_defaults(run=cmd_timeline)

    p = sub.add_parser("live", help="replay a learner session in real time to the tool's POST /input")
    _add_session_args(p)
    _add_mapping_args(p)
    p.add_argument("--url", default=DEFAULT_URL)
    p.add_argument("--rate", type=_number(1, 120), default=30.0, help="messages per second (1-120)")
    p.add_argument("--replay-speed", type=_number(0, 100, lo_open=True), default=1.0)
    p.add_argument("--loop", action="store_true")
    p.add_argument("--dry-run", action="store_true", help="print messages instead of sending them")
    p.add_argument("--install", action="store_true", help="copy the demo video into the tool's videos/ folder")
    p.set_defaults(run=cmd_live)

    p = sub.add_parser("evaluate", help="compare trackers against truth.csv (dummy data)")
    _add_session_args(p)
    p.add_argument("--trackers", nargs="+", choices=TRACKERS)
    p.set_defaults(run=cmd_evaluate)

    p = sub.add_parser("pose", help="extract MediaPipe landmarks of a demo video (for focus)")
    p.add_argument("video")
    p.add_argument("--side", choices=("right", "left"), default="right")
    p.add_argument("--out")
    p.add_argument("--algorithms")
    p.set_defaults(run=cmd_pose)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.run(args)
    except BridgeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
