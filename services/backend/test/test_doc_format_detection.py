from __future__ import annotations

from app.services.project_fs_service import doc_format_for_name, is_text_payload


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


class TestIsTextPayload:
    def test_plain_utf8_text_is_text(self) -> None:
        assert is_text_payload("hello world\n".encode("utf-8")) is True

    def test_utf8_with_multibyte_chars_is_text(self) -> None:
        assert is_text_payload("中文内容 αβγ\n".encode("utf-8")) is True

    def test_empty_payload_is_text(self) -> None:
        assert is_text_payload(b"") is True

    def test_payload_with_null_byte_is_binary(self) -> None:
        assert is_text_payload(b"PK\x03\x04\x00\x00") is False

    def test_invalid_utf8_is_binary(self) -> None:
        # 0xa3 is a lone continuation byte — invalid UTF-8 start.
        assert is_text_payload(b"\xa3\xa3\xa3") is False

    def test_png_header_is_binary(self) -> None:
        png_magic = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        assert is_text_payload(png_magic) is False

    def test_only_first_8kb_is_inspected(self) -> None:
        # 8KB of valid text, then a null byte beyond the window -> still text.
        payload = (b"a" * 8192) + b"\x00"
        assert is_text_payload(payload) is True
