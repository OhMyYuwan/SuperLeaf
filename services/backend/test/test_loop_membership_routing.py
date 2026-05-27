"""Pure-structure test for Loop membership routing.

Verifies that the graph emitted by the frontend (with `_ui.parent_id` populated
from edge handles by `flowToGraph`) is interpreted correctly by the
orchestrator's static helpers:

  1. `_parent_id(node)` returns the loop owner.
  2. The top-level DAG excludes loop children but keeps the Loop container.
  3. The membership edges (Loop↔Agent via loop-in-source / loop-out-target)
     don't pollute the top-level DAG (they have one endpoint inside the loop).
  4. Internal Agent→Agent edges form the child subgraph correctly.

No LLM, no DB — pure Python.
"""

from app.services.agent_orchestrator import _edge_source, _edge_target, _parent_id


def _build_sample_graph() -> dict:
    """Mirror what the frontend emits after the new edge-based loop UI:

        Input → Loop(left) → A → B → Loop(right) → Output

        - Input → Loop(left)              : external in       (loop-in-target)
        - Loop(left) → A                  : distribute (membership marker, loop-in-source)
        - A → B                           : internal chain
        - B → Loop(right)                 : aggregate (membership marker, loop-out-target)
        - Loop(right) → Output            : external out      (loop-out-source)

    `flowToGraph` writes `_ui.parent_id = 'L1'` on A and B (B propagated via
    the A→B chain).
    """
    return {
        "nodes": [
            {"id": "in1", "type": "input", "config": {"_ui": {}}},
            {"id": "L1", "type": "loop", "config": {"rounds": 2, "_ui": {}}},
            {"id": "A", "type": "agent", "config": {"_ui": {"parent_id": "L1"}}},
            {"id": "B", "type": "agent", "config": {"_ui": {"parent_id": "L1"}}},
            {"id": "out1", "type": "output", "config": {"_ui": {}}},
        ],
        "edges": [
            {"source": "in1", "target": "L1"},
            {"source": "L1", "target": "A"},
            {"source": "A", "target": "B"},
            {"source": "B", "target": "L1"},
            {"source": "L1", "target": "out1"},
        ],
    }


def test_parent_id_extraction():
    g = _build_sample_graph()
    by_id = {n["id"]: n for n in g["nodes"]}
    assert _parent_id(by_id["A"]) == "L1"
    assert _parent_id(by_id["B"]) == "L1"
    assert _parent_id(by_id["L1"]) is None
    assert _parent_id(by_id["in1"]) is None
    assert _parent_id(by_id["out1"]) is None
    print("  ✓ _parent_id correctly identifies loop members vs top-level")


def test_top_level_dag_excludes_loop_children():
    g = _build_sample_graph()
    nodes = g["nodes"]
    edges = g["edges"]

    loop_ids = {n["id"] for n in nodes if n.get("type") == "loop"}
    child_ids = {n["id"] for n in nodes if _parent_id(n) in loop_ids}
    top_node_ids = {n["id"] for n in nodes if n.get("type") != "loop" and n["id"] not in child_ids}
    for ln in nodes:
        if ln.get("type") == "loop" and not _parent_id(ln):
            top_node_ids.add(ln["id"])

    assert top_node_ids == {"in1", "L1", "out1"}, top_node_ids
    assert child_ids == {"A", "B"}, child_ids

    top_edges = [
        e for e in edges
        if _edge_source(e) in top_node_ids and _edge_target(e) in top_node_ids
    ]
    pairs = sorted((_edge_source(e), _edge_target(e)) for e in top_edges)
    assert pairs == [("L1", "out1"), ("in1", "L1")], pairs
    print("  ✓ Top-level DAG = in1 → L1 → out1 (membership edges filtered out)")


def test_loop_body_subgraph():
    g = _build_sample_graph()
    nodes = g["nodes"]
    edges = g["edges"]

    child_nodes = [n for n in nodes if _parent_id(n) == "L1"]
    child_ids = {n["id"] for n in child_nodes}
    child_edges = [
        e for e in edges
        if _edge_source(e) in child_ids and _edge_target(e) in child_ids
    ]

    assert child_ids == {"A", "B"}
    pairs = sorted((_edge_source(e), _edge_target(e)) for e in child_edges)
    assert pairs == [("A", "B")], pairs
    print("  ✓ Loop body subgraph = A → B (membership markers excluded)")


def test_nested_loop():
    """Loop containing another Loop: inner agent's parent_id points to inner loop,
    inner loop's parent_id points to outer. _parent_id only resolves one level —
    nested loops handle their own descendants via recursion.
    """
    nodes = [
        {"id": "L_outer", "type": "loop", "config": {"_ui": {}}},
        {"id": "L_inner", "type": "loop", "config": {"_ui": {"parent_id": "L_outer"}}},
        {"id": "X", "type": "agent", "config": {"_ui": {"parent_id": "L_inner"}}},
    ]
    by_id = {n["id"]: n for n in nodes}
    assert _parent_id(by_id["L_inner"]) == "L_outer"
    assert _parent_id(by_id["X"]) == "L_inner"
    # X is not a direct child of L_outer — orchestrator must recurse via L_inner.
    direct_children_of_outer = [n for n in nodes if _parent_id(n) == "L_outer"]
    assert {n["id"] for n in direct_children_of_outer} == {"L_inner"}
    print("  ✓ Nested loops: each level only sees its direct children")


if __name__ == "__main__":
    print("Loop membership routing — frontend graph → backend execution")
    print("=" * 60)
    test_parent_id_extraction()
    test_top_level_dag_excludes_loop_children()
    test_loop_body_subgraph()
    test_nested_loop()
    print("=" * 60)
    print("✅ All checks passed.")
