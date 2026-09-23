import json
from pathlib import Path

import pytest

from app import (
    InputValidationError,
    available_cases,
    euclidean_distance,
    export_top_performer_csv,
    find_nearest_agent,
    generate_report,
    load_json,
    parse_input,
    render_ascii_routes,
    simulate,
    simulate_with_joining_agent,
)


ROOT = Path(__file__).resolve().parents[1]


def test_euclidean_distance_uses_pythagorean_formula():
    assert euclidean_distance((0, 0), (3, 4)) == pytest.approx(5.0)
    assert euclidean_distance((-2, -3), (1, 1)) == pytest.approx(5.0)


def test_nearest_agent_is_selected_with_deterministic_tie_break():
    agents = {"A2": [1, 0], "A1": [-1, 0], "A3": [10, 10]}
    assert find_nearest_agent([0, 0], agents) == "A1"


def test_base_case_assignments_match_nearest_warehouses():
    result = simulate(load_json(ROOT / "base_case.json"))
    mapping = {row["package_id"]: row["agent_id"] for row in result["assignments"]}
    assert mapping == {"P1": "A1", "P2": "A2", "P3": "A3", "P4": "A1", "P5": "A2"}
    assert result["summary"]["packages_delivered"] == 5
    assert result["summary"]["best_agent"] == "A3"


def test_every_supplied_case_delivers_every_package():
    for name, path in available_cases().items():
        raw = load_json(path)
        result = simulate(raw)
        assert result["summary"]["packages_delivered"] == len(raw["packages"]), name
        assigned_ids = [row["package_id"] for row in result["assignments"]]
        assert len(assigned_ids) == len(set(assigned_ids)), name


def test_both_assignment_schema_variants_are_supported():
    list_schema = {
        "warehouses": [{"id": "W1", "location": [0, 0]}],
        "agents": [{"id": "A1", "location": [2, 0]}],
        "packages": [{"id": "P1", "warehouse_id": "W1", "destination": [3, 4]}],
    }
    warehouses, agents, packages = parse_input(list_schema)
    assert warehouses[0].id == "W1"
    assert agents[0].location == (2.0, 0.0)
    assert packages[0].warehouse_id == "W1"
    assert simulate(list_schema)["summary"]["total_distance"] == 7.0


def test_report_shape_matches_assignment_brief():
    report = generate_report(load_json(ROOT / "base_case.json"))
    assert report["best_agent"] == "A3"
    for agent_id in ("A1", "A2", "A3"):
        assert {"packages_delivered", "total_distance", "efficiency"} <= report[agent_id].keys()


@pytest.mark.parametrize(
    "payload, message",
    [
        ({"agents": {}, "packages": []}, "Missing required field"),
        (
            {
                "warehouses": {"W1": [0, 0]},
                "agents": {"A1": [1, 1]},
                "packages": [{"id": "P1", "warehouse": "W9", "destination": [2, 2]}],
            },
            "unknown warehouse",
        ),
        (
            {
                "warehouses": {"W1": [0, 0]},
                "agents": {"A1": [1, 1]},
                "packages": [
                    {"id": "P1", "warehouse": "W1", "destination": [2, 2]},
                    {"id": "P1", "warehouse": "W1", "destination": [3, 3]},
                ],
            },
            "Duplicate package",
        ),
    ],
)
def test_invalid_inputs_fail_with_clear_messages(payload, message):
    with pytest.raises(InputValidationError, match=message):
        simulate(payload)


def test_cli_report_is_json_serializable():
    result = simulate(load_json(ROOT / "base_case.json"))
    encoded = json.dumps(result)
    assert '"packages_delivered": 5' in encoded


def test_random_delays_are_seeded_and_bounded():
    data = load_json(ROOT / "base_case.json")
    first = simulate(data, random_delays=True, seed=42, max_delay_minutes=20)
    second = simulate(data, random_delays=True, seed=42, max_delay_minutes=20)
    delays = [route["delay_minutes"] for route in first["assignments"]]
    assert delays == [route["delay_minutes"] for route in second["assignments"]]
    assert all(0 <= delay <= 20 for delay in delays)
    assert first["summary"]["total_delay_minutes"] == sum(delays)


def test_agent_can_join_midday_and_receive_remaining_packages():
    data = load_json(ROOT / "base_case.json")
    result = simulate_with_joining_agent(data, "AX", [0, 0], joins_after=3)
    assert "AX" in result["agents"]
    assert result["events"]["joining_agent"]["joined_after_packages"] == 3
    assert result["summary"]["packages_delivered"] == 5
    assert result["assignments"][:3] == simulate(data)["assignments"][:3]


def test_ascii_map_contains_network_legend():
    output = render_ascii_routes(simulate(load_json(ROOT / "base_case.json")))
    assert "Legend: A agent" in output
    assert "W" in output and "P" in output


def test_top_performer_csv_export(tmp_path):
    result = simulate(load_json(ROOT / "base_case.json"))
    destination = export_top_performer_csv(result, tmp_path / "winner.csv")
    content = destination.read_text(encoding="utf-8")
    assert "agent_id,packages_delivered,total_distance,efficiency,package_ids" in content
    assert "\nA3," in content


def test_api_supports_optional_simulation_events():
    from app import app

    response = app.test_client().post(
        "/api/simulate",
        json={
            "case": "base_case.json",
            "options": {
                "random_delays": True,
                "seed": 7,
                "joining_agent": {"id": "AX", "location": [0, 0]},
                "joins_after": 2,
            },
        },
    )
    body = response.get_json()
    assert response.status_code == 200
    assert body["result"]["summary"]["total_agents"] == 4
    assert body["result"]["events"]["random_delays_enabled"] is True
