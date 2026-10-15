"""The commands Muse can invoke on the avatar display.

Each spec uses the same shape as the Linux SDK's ``COMMAND_SPECS``
(``description``, ``required``, ``optional``, ``timeout_ms``), so the two
dictionaries merge into one ``commands_v2`` registration. Muse reads the
descriptions to decide when to call a command, so they say what the person in
front of the display will see.

Only the parameter types the SDK's own commands use (``string``, ``integer``)
appear here. Lists go in as newline-separated strings and fractions as whole
percentages.
"""

from __future__ import annotations

EXPRESSIONS = ("neutral", "happy", "excited", "thinking", "surprised", "sad",
               "confused", "wink", "love", "sleepy")
GESTURES = ("wave", "nod", "shake", "shrug", "bow", "spin", "celebrate", "point_left", "point_right")
SHAPES = ("planet", "solar_system", "dna", "heart", "globe", "molecule", "rocket",
          "torus_knot", "cube", "crystal")
THEMES = ("night", "sunrise", "ocean", "studio", "aurora")

DISPLAY_TIMEOUT_MS = 15_000
MAX_TEXT = 2_000
MAX_URL = 2_048
# /link-control takes at most 256 KiB per message; leave room for the envelope.
MAX_IMAGE_BASE64 = 190_000

AVATAR_COMMANDS: dict[str, dict] = {
    "avatar.express": {
        "description": (
            "Change the facial expression of the 3D avatar on the user's glasses-free 3D display. "
            "Use it to react visibly while you talk. Expressions: " + ", ".join(EXPRESSIONS) + "."
        ),
        "required": {
            "expression": {"type": "string", "description": "One of: " + ", ".join(EXPRESSIONS) + "."},
        },
        "optional": {
            "seconds": {"type": "integer", "description": "How long to hold it before relaxing (1-60). Default 4."},
        },
    },
    "avatar.gesture": {
        "description": (
            "Make the 3D avatar on the display do a body gesture once. Gestures: "
            + ", ".join(GESTURES) + "."
        ),
        "required": {
            "gesture": {"type": "string", "description": "One of: " + ", ".join(GESTURES) + "."},
        },
        "optional": {},
    },
    "avatar.say": {
        "description": (
            "Make the avatar speak a short line out loud through the display's speakers, with a "
            "caption. Use it for announcements, reminders or scheduled check-ins when the user is "
            "not already talking to you through the avatar."
        ),
        "required": {
            "text": {"type": "string", "description": "What to say, at most 2000 characters."},
        },
        "optional": {
            "expression": {"type": "string", "description": "Expression while speaking, as in avatar.express."},
        },
    },
    "display.show_image": {
        "description": (
            "Show an image in 3D next to the avatar, on a floating frame. Give a public https URL, "
            "or a small image as base64 (under 140 KB). Replaces whatever was shown before."
        ),
        "required": {},
        "optional": {
            "url": {"type": "string", "description": "https URL of a PNG, JPEG, GIF or WebP image."},
            "data_base64": {"type": "string", "description": "The image bytes, base64. Use instead of url."},
            "mime_type": {"type": "string", "description": "With data_base64: image/png, image/jpeg or image/webp."},
            "caption": {"type": "string", "description": "A short caption under the image."},
        },
    },
    "display.show_model": {
        "description": (
            "Show a 3D model (glTF 2.0, .glb or .gltf) floating in glasses-free 3D next to the "
            "avatar. The URL must be public and allow cross-origin requests (CORS)."
        ),
        "required": {
            "url": {"type": "string", "description": "https URL of the .glb or .gltf file."},
        },
        "optional": {
            "caption": {"type": "string", "description": "A short caption under the model."},
            "spin": {"type": "integer", "description": "1 to turn slowly (default), 0 to hold still."},
        },
    },
    "display.show_shape": {
        "description": (
            "Show a built-in animated 3D object next to the avatar, with no download. Shapes: "
            + ", ".join(SHAPES) + ". Use it to illustrate what you are explaining."
        ),
        "required": {
            "shape": {"type": "string", "description": "One of: " + ", ".join(SHAPES) + "."},
        },
        "optional": {
            "caption": {"type": "string", "description": "A short caption under the object."},
            "color": {"type": "string", "description": "Main color as #rrggbb. Default depends on the shape."},
        },
    },
    "display.show_card": {
        "description": (
            "Show a floating information card next to the avatar: a title, a body and up to six "
            "bullet points. Good for lists, steps, schedules, scores and summaries."
        ),
        "required": {
            "title": {"type": "string", "description": "The card title, at most 80 characters."},
        },
        "optional": {
            "body": {"type": "string", "description": "One or two short sentences."},
            "bullets": {"type": "string", "description": "Bullet points, one per line, at most six."},
            "accent": {"type": "string", "description": "Accent color as #rrggbb."},
        },
    },
    "display.clear": {
        "description": "Remove the image, model, shape or card shown next to the avatar.",
        "required": {},
        "optional": {},
    },
    "display.set_depth": {
        "description": (
            "Adjust the 3D effect on the display. strength scales the stereo depth (0 is flat, "
            "100 is full). pop moves the avatar out of the screen toward the viewer (positive) or "
            "back behind it (negative)."
        ),
        "required": {},
        "optional": {
            "strength": {"type": "integer", "description": "Stereo depth, 0-100. Default 100."},
            "pop": {"type": "integer", "description": "-100 (behind the glass) to 100 (out of it). Default 0."},
        },
    },
    "display.set_mode": {
        "description": "Switch the display between glasses-free 3D and flat 2D.",
        "required": {
            "mode": {"type": "string", "description": "\"3d\" or \"2d\"."},
        },
        "optional": {},
    },
    "display.set_theme": {
        "description": "Change the backdrop behind the avatar. Themes: " + ", ".join(THEMES) + ".",
        "required": {
            "theme": {"type": "string", "description": "One of: " + ", ".join(THEMES) + "."},
        },
        "optional": {},
    },
    "display.status": {
        "description": (
            "Report what the avatar display shows now: whether it is in 3D, whether a viewer is "
            "in front of it (head tracking), and the current expression and content."
        ),
        "required": {},
        "optional": {},
    },
}

for _spec in AVATAR_COMMANDS.values():
    _spec["timeout_ms"] = DISPLAY_TIMEOUT_MS

_ENUMS = {
    ("avatar.express", "expression"): EXPRESSIONS,
    ("avatar.say", "expression"): EXPRESSIONS,
    ("avatar.gesture", "gesture"): GESTURES,
    ("display.show_shape", "shape"): SHAPES,
    ("display.set_mode", "mode"): ("3d", "2d"),
    ("display.set_theme", "theme"): THEMES,
}
_RANGES = {
    ("avatar.express", "seconds"): (1, 60),
    ("display.show_model", "spin"): (0, 1),
    ("display.set_depth", "strength"): (0, 100),
    ("display.set_depth", "pop"): (-100, 100),
}
_IMAGE_TYPES = ("image/png", "image/jpeg", "image/webp", "image/gif")


class InvalidParams(ValueError):
    """Muse sent parameters the display cannot use; the message goes back to Muse."""


def validate(command: str, params: dict) -> dict:
    """Return the parameters a display may act on, or raise InvalidParams.

    Unknown parameters are dropped. Strings are trimmed and capped, enum values
    lower-cased, and integers range-checked, so the page never sees anything a
    spec does not describe.
    """
    spec = AVATAR_COMMANDS.get(command)
    if spec is None:
        raise InvalidParams(f"unknown display command {command!r}")
    if not isinstance(params, dict):
        raise InvalidParams("params must be an object")
    clean: dict = {}
    fields = {**spec["optional"], **spec["required"]}
    for name, field in fields.items():
        value = params.get(name)
        if value is None or value == "":
            if name in spec["required"]:
                raise InvalidParams(f"{name} is required")
            continue
        if field["type"] == "integer":
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value):
                raise InvalidParams(f"{name} must be a whole number")
            value = int(value)
            low, high = _RANGES.get((command, name), (-(2 ** 31), 2 ** 31 - 1))
            if not low <= value <= high:
                raise InvalidParams(f"{name} must be between {low} and {high}")
        else:
            if not isinstance(value, str):
                raise InvalidParams(f"{name} must be a string")
            value = value.strip()
            limit = MAX_IMAGE_BASE64 if name == "data_base64" else MAX_URL if name == "url" else MAX_TEXT
            if len(value) > limit:
                raise InvalidParams(f"{name} is longer than {limit} characters")
            choices = _ENUMS.get((command, name))
            if choices is not None:
                value = value.lower()
                if value not in choices:
                    raise InvalidParams(f"{name} must be one of: {', '.join(choices)}")
        clean[name] = value
    _check_sources(command, clean)
    return clean


def _check_sources(command: str, clean: dict) -> None:
    url = clean.get("url")
    if url is not None and not url.lower().startswith("https://"):
        raise InvalidParams("url must start with https://")
    for name in ("color", "accent"):
        color = clean.get(name)
        if color is not None and not _is_hex_color(color):
            raise InvalidParams(f"{name} must look like #33aaff")
    if command == "display.show_image":
        if ("url" in clean) == ("data_base64" in clean):
            raise InvalidParams("give exactly one of url or data_base64")
        if "data_base64" in clean:
            mime = clean.get("mime_type", "").lower()
            if mime not in _IMAGE_TYPES:
                raise InvalidParams("mime_type must be one of: " + ", ".join(_IMAGE_TYPES))
            clean["mime_type"] = mime
    if command == "display.show_card" and "bullets" in clean:
        lines = [line.strip(" \t-*•") for line in clean["bullets"].splitlines()]
        clean["bullets"] = [line for line in lines if line][:6]


def _is_hex_color(value: str) -> bool:
    return (len(value) == 7 and value[0] == "#"
            and all(ch in "0123456789abcdefABCDEF" for ch in value[1:]))
