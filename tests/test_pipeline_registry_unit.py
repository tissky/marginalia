from __future__ import annotations

from marginalia.pipelines import resolve_pipeline
from marginalia.pipelines.archive import _resolve_inner


def test_image_pipeline_routes_only_supported_raster_mimes() -> None:
    assert resolve_pipeline("image/png", ".png", filename="pixel.png").name == "image"
    assert resolve_pipeline("image/jpeg", ".jpg", filename="photo.jpg").name == "image"


def test_svg_routes_to_text_pipeline() -> None:
    assert resolve_pipeline("image/svg+xml", ".svg", filename="icon.svg").name == "text"
    assert resolve_pipeline("", ".svg", filename="diagram.svg").name == "text"


def test_archive_svg_member_routes_to_text_pipeline() -> None:
    assert _resolve_inner("diagrams/path-only.svg").name == "text"
