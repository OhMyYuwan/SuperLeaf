from __future__ import annotations

from app.services.project_fs_service import doc_format_for_name  # is_text_payload added in Task 2


class TestDocFormatForName:
    def test_tex_extensions_map_to_tex(self) -> None:
        for name in ("main.tex", "ref.bib", "pkg.sty", "doc.latex", "a.ltx", "c.cls", "b.bst"):
            assert doc_format_for_name(name) == "tex", name

    def test_markdown_extensions_map_to_md(self) -> None:
        assert doc_format_for_name("readme.md") == "md"
        assert doc_format_for_name("notes.markdown") == "md"

    def test_txt_extension_maps_to_txt(self) -> None:
        assert doc_format_for_name("notes.txt") == "txt"

    def test_unknown_text_extension_defaults_to_txt(self) -> None:
        assert doc_format_for_name("diagram.tikz") == "txt"
        assert doc_format_for_name("config.cfg") == "txt"
        assert doc_format_for_name("scratch.note") == "txt"

    def test_no_extension_defaults_to_txt(self) -> None:
        assert doc_format_for_name("Makefile") == "txt"

    def test_uppercase_extension_is_normalized(self) -> None:
        assert doc_format_for_name("MAIN.TEX") == "tex"
