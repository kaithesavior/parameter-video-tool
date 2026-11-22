"""Stickies bridge: Video-Sticky-Algorithms -> parameters -> parameter video tool.

    learner sticky data + demo MediaPipe data
        -> tracker (where in the demo the learner is, from Video-Sticky-Algorithms)
        -> parameters (speed, zoom, focus)
        -> cue timeline JSON (offline) or POST /input (live)

Run ``python3 -m stickies_bridge --help``.
"""

__version__ = "0.1.0"
