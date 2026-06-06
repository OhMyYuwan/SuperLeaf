from pathlib import Path

from app.services.latex_compiler import LatexCompilerService


def test_line_column_from_offset_uses_one_based_lines_and_zero_based_columns() -> None:
    assert LatexCompilerService._line_column_from_offset("alpha\nbeta\ngamma", 8) == (2, 2)


def test_relative_posix_path_is_from_main_document_directory() -> None:
    assert (
        LatexCompilerService._relative_posix_path(Path("sections/intro.tex"), Path("."))
        == "sections/intro.tex"
    )
    assert (
        LatexCompilerService._relative_posix_path(Path("chapters/intro.tex"), Path("main"))
        == "../chapters/intro.tex"
    )


def test_parse_synctex_view_output_prefers_page_coordinates() -> None:
    output = """
SyncTeX result begin
Output:output.pdf
Page:2
x:126.500000
y:244.000000
h:124.000000
v:300.000000
W:20.000000
H:9.000000
SyncTeX result end
"""
    assert LatexCompilerService._parse_synctex_view_output(output) == {
        "page": 2,
        "x": 126.5,
        "y": 244.0,
        "width": 20.0,
        "height": 9.0,
    }
