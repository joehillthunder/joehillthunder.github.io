import pytest

from muse_avatar.commands import AVATAR_COMMANDS, InvalidParams, validate


def test_every_spec_has_the_sdk_shape():
    for name, spec in AVATAR_COMMANDS.items():
        assert name.count(".") == 1
        assert spec["description"]
        assert spec["timeout_ms"] > 0
        for field in {**spec["required"], **spec["optional"]}.values():
            assert field["type"] in ("string", "integer")
            assert field["description"]


def test_enums_are_normalised_and_checked():
    assert validate("avatar.express", {"expression": " Happy "}) == {"expression": "happy"}
    with pytest.raises(InvalidParams, match="expression must be one of"):
        validate("avatar.express", {"expression": "smug"})


def test_required_unknown_and_extra_parameters():
    with pytest.raises(InvalidParams, match="gesture is required"):
        validate("avatar.gesture", {})
    with pytest.raises(InvalidParams, match="unknown display command"):
        validate("avatar.dance", {})
    assert validate("avatar.gesture", {"gesture": "wave", "extra": 1}) == {"gesture": "wave"}


def test_integers_are_whole_and_in_range():
    assert validate("display.set_depth", {"strength": 40.0, "pop": -20}) == {"strength": 40, "pop": -20}
    for bad in ({"strength": 101}, {"pop": 3.5}, {"strength": True}, {"strength": "50"}):
        with pytest.raises(InvalidParams):
            validate("display.set_depth", bad)


def test_image_needs_exactly_one_source():
    with pytest.raises(InvalidParams, match="exactly one"):
        validate("display.show_image", {})
    with pytest.raises(InvalidParams, match="exactly one"):
        validate("display.show_image", {"url": "https://a/b.png", "data_base64": "AAAA", "mime_type": "image/png"})
    with pytest.raises(InvalidParams, match="https"):
        validate("display.show_image", {"url": "http://a/b.png"})
    with pytest.raises(InvalidParams, match="mime_type"):
        validate("display.show_image", {"data_base64": "AAAA", "mime_type": "text/html"})
    assert validate("display.show_image", {"data_base64": "AAAA", "mime_type": "IMAGE/PNG"}) == {
        "data_base64": "AAAA", "mime_type": "image/png"}


def test_card_bullets_become_a_short_list():
    clean = validate("display.show_card", {"title": "Today", "bullets": "- one\n\n* two\n3\n4\n5\n6\n7"})
    assert clean["bullets"] == ["one", "two", "3", "4", "5", "6"]


def test_colors_are_hex():
    assert validate("display.show_shape", {"shape": "dna", "color": "#33AAff"})["color"] == "#33AAff"
    with pytest.raises(InvalidParams, match="color"):
        validate("display.show_shape", {"shape": "dna", "color": "red; background:url(x)"})


def test_strings_are_capped():
    with pytest.raises(InvalidParams, match="longer than"):
        validate("avatar.say", {"text": "x" * 2001})
