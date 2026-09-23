#!/usr/bin/env python3
"""FastBox delivery simulator.

The assignment's required algorithm is intentionally kept small and explicit:
each package is assigned to the agent nearest to its warehouse, using Euclidean
distance. A delivery route is agent -> warehouse -> destination.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

from flask import Flask, jsonify, render_template, request


ROOT = Path(__file__).resolve().parent
TEST_CASES_DIR = ROOT / "Python Assignment(Delivery System Test Cases)"


class InputValidationError(ValueError):
    """Raised when a simulation input does not match the required schema."""


@dataclass(frozen=True)
class Warehouse:
    id: str
    location: tuple[float, float]


@dataclass(frozen=True)
class Agent:
    id: str
    location: tuple[float, float]


@dataclass(frozen=True)
class Package:
    id: str
    warehouse_id: str
    destination: tuple[float, float]


@dataclass(frozen=True)
class Assignment:
    package_id: str
    agent_id: str
    warehouse_id: str
    agent_start: tuple[float, float]
    warehouse_location: tuple[float, float]
    destination: tuple[float, float]
    pickup_distance: float
    delivery_distance: float
    total_distance: float
    delay_minutes: int = 0


def euclidean_distance(point_a: Iterable[float], point_b: Iterable[float]) -> float:
    """Return the straight-line distance between two 2D points."""
    a = tuple(point_a)
    b = tuple(point_b)
    if len(a) != 2 or len(b) != 2:
        raise InputValidationError("Distance requires two 2D coordinates.")
    return math.hypot(float(b[0]) - float(a[0]), float(b[1]) - float(a[1]))


# Conventional alias retained for simple evaluator imports.
calculate_distance = euclidean_distance


def _coordinate(value: Any, label: str) -> tuple[float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise InputValidationError(f"{label} must be a two-number coordinate.")
    if any(isinstance(item, bool) or not isinstance(item, (int, float)) for item in value):
        raise InputValidationError(f"{label} must contain only numbers.")
    numbers = (float(value[0]), float(value[1]))
    if not all(math.isfinite(number) for number in numbers):
        raise InputValidationError(f"{label} must contain finite numbers.")
    return numbers


def _entities(raw: Any, entity_name: str) -> list[tuple[str, tuple[float, float]]]:
    """Normalize both assignment schema variants: mappings and id/location lists."""
    if isinstance(raw, dict):
        entries = [(str(entity_id), location) for entity_id, location in raw.items()]
    elif isinstance(raw, list):
        entries = []
        for index, item in enumerate(raw):
            if not isinstance(item, dict) or "id" not in item or "location" not in item:
                raise InputValidationError(
                    f"{entity_name}[{index}] needs 'id' and 'location' fields."
                )
            entries.append((str(item["id"]), item["location"]))
    else:
        raise InputValidationError(f"'{entity_name}' must be an object or an array.")

    if not entries:
        raise InputValidationError(f"At least one {entity_name[:-1]} is required.")

    ids = [entity_id for entity_id, _ in entries]
    if len(ids) != len(set(ids)):
        raise InputValidationError(f"{entity_name.title()} IDs must be unique.")
    return [
        (entity_id, _coordinate(location, f"{entity_name}.{entity_id}"))
        for entity_id, location in entries
    ]


def parse_input(data: Any) -> tuple[list[Warehouse], list[Agent], list[Package]]:
    """Validate and convert raw JSON-compatible data into domain objects."""
    if not isinstance(data, dict):
        raise InputValidationError("The input root must be a JSON object.")
    missing = {"warehouses", "agents", "packages"} - data.keys()
    if missing:
        raise InputValidationError(f"Missing required field(s): {', '.join(sorted(missing))}.")

    warehouses = [Warehouse(*entry) for entry in _entities(data["warehouses"], "warehouses")]
    agents = [Agent(*entry) for entry in _entities(data["agents"], "agents")]
    warehouse_ids = {warehouse.id for warehouse in warehouses}

    raw_packages = data["packages"]
    if not isinstance(raw_packages, list):
        raise InputValidationError("'packages' must be an array.")

    packages: list[Package] = []
    package_ids: set[str] = set()
    for index, item in enumerate(raw_packages):
        if not isinstance(item, dict):
            raise InputValidationError(f"packages[{index}] must be an object.")
        package_id = str(item.get("id", "")).strip()
        warehouse_id = str(item.get("warehouse", item.get("warehouse_id", ""))).strip()
        if not package_id:
            raise InputValidationError(f"packages[{index}] needs a non-empty 'id'.")
        if package_id in package_ids:
            raise InputValidationError(f"Duplicate package ID: {package_id}.")
        if warehouse_id not in warehouse_ids:
            raise InputValidationError(
                f"Package {package_id} references unknown warehouse '{warehouse_id}'."
            )
        if "destination" not in item:
            raise InputValidationError(f"Package {package_id} needs a 'destination'.")
        package_ids.add(package_id)
        packages.append(
            Package(
                id=package_id,
                warehouse_id=warehouse_id,
                destination=_coordinate(
                    item["destination"], f"packages.{package_id}.destination"
                ),
            )
        )
    return warehouses, agents, packages


def load_json(path: str | Path) -> dict[str, Any]:
    """Read a UTF-8 JSON file and return the parsed object."""
    source = Path(path)
    try:
        with source.open("r", encoding="utf-8") as file:
            data = json.load(file)
    except FileNotFoundError as error:
        raise InputValidationError(f"Input file not found: {source}") from error
    except json.JSONDecodeError as error:
        raise InputValidationError(
            f"Invalid JSON at line {error.lineno}, column {error.colno}: {error.msg}"
        ) from error
    if not isinstance(data, dict):
        raise InputValidationError("The input root must be a JSON object.")
    return data


def nearest_agent(warehouse: Warehouse, agents: list[Agent]) -> tuple[Agent, float]:
    """Find the nearest agent; agent ID is the deterministic tie-breaker."""
    if not agents:
        raise InputValidationError("At least one agent is required.")
    ranked = sorted(
        (
            (euclidean_distance(agent.location, warehouse.location), agent.id, agent)
            for agent in agents
        ),
        key=lambda item: (item[0], item[1]),
    )
    distance, _, agent = ranked[0]
    return agent, distance


def find_nearest_agent(
    warehouse_location: Iterable[float], agents: dict[str, Iterable[float]]
) -> str:
    """Compatibility helper returning the nearest ID from a simple agent mapping."""
    warehouse = Warehouse("_warehouse", _coordinate(warehouse_location, "warehouse"))
    normalized = [
        Agent(str(agent_id), _coordinate(location, f"agents.{agent_id}"))
        for agent_id, location in agents.items()
    ]
    return nearest_agent(warehouse, normalized)[0].id


def simulate(
    data: dict[str, Any],
    *,
    random_delays: bool = False,
    seed: int | None = None,
    max_delay_minutes: int = 45,
    joining_agent: Agent | None = None,
    joins_after: int = 0,
) -> dict[str, Any]:
    """Run one day of FastBox operations and return a serializable report.

    Optional simulation extensions are opt-in so the assignment's required
    nearest-agent result remains deterministic by default.
    """
    warehouses, agents, packages = parse_input(data)
    warehouse_by_id = {warehouse.id: warehouse for warehouse in warehouses}
    if max_delay_minutes < 0:
        raise InputValidationError("Maximum delay cannot be negative.")
    if joins_after < 0:
        raise InputValidationError("'joins_after' cannot be negative.")
    if joining_agent and any(agent.id == joining_agent.id for agent in agents):
        raise InputValidationError(f"Agent ID '{joining_agent.id}' already exists.")
    rng = random.Random(seed)
    active_agents = list(agents)
    join_applied = False

    assignments: list[Assignment] = []
    for package_index, package in enumerate(packages):
        if joining_agent and not join_applied and package_index >= joins_after:
            active_agents.append(joining_agent)
            join_applied = True
        warehouse = warehouse_by_id[package.warehouse_id]
        agent, pickup_distance = nearest_agent(warehouse, active_agents)
        delivery_distance = euclidean_distance(warehouse.location, package.destination)
        delay_minutes = rng.randint(0, max_delay_minutes) if random_delays else 0
        assignments.append(
            Assignment(
                package_id=package.id,
                agent_id=agent.id,
                warehouse_id=warehouse.id,
                agent_start=agent.location,
                warehouse_location=warehouse.location,
                destination=package.destination,
                pickup_distance=pickup_distance,
                delivery_distance=delivery_distance,
                total_distance=pickup_distance + delivery_distance,
                delay_minutes=delay_minutes,
            )
        )
    if joining_agent and not join_applied:
        active_agents.append(joining_agent)

    report: dict[str, dict[str, Any]] = {}
    for agent in sorted(active_agents, key=lambda item: item.id):
        routes = [assignment for assignment in assignments if assignment.agent_id == agent.id]
        total_distance = sum(route.total_distance for route in routes)
        package_count = len(routes)
        report[agent.id] = {
            "packages_delivered": package_count,
            "package_ids": [route.package_id for route in routes],
            "pickup_distance": round(sum(route.pickup_distance for route in routes), 2),
            "delivery_distance": round(sum(route.delivery_distance for route in routes), 2),
            "total_distance": round(total_distance, 2),
            "efficiency": round(total_distance / package_count, 2) if package_count else None,
            "delay_minutes": sum(route.delay_minutes for route in routes),
        }

    ranked_agents = [
        (metrics["efficiency"], agent_id)
        for agent_id, metrics in report.items()
        if metrics["packages_delivered"] > 0
    ]
    best_agent = min(ranked_agents)[1] if ranked_agents else None
    total_distance = sum(assignment.total_distance for assignment in assignments)

    return {
        "summary": {
            "packages_delivered": len(assignments),
            "total_packages": len(packages),
            "active_agents": len(ranked_agents),
            "total_agents": len(active_agents),
            "total_distance": round(total_distance, 2),
            "average_distance": round(total_distance / len(assignments), 2)
            if assignments
            else 0.0,
            "best_agent": best_agent,
            "total_delay_minutes": sum(route.delay_minutes for route in assignments),
            "delayed_packages": sum(route.delay_minutes > 0 for route in assignments),
        },
        "agents": report,
        "assignments": [_rounded_assignment(item) for item in assignments],
        "network": {
            "warehouses": [
                {"id": warehouse.id, "location": list(warehouse.location)}
                for warehouse in warehouses
            ],
            "agents": [
                {
                    "id": agent.id,
                    "location": list(agent.location),
                    "joined_midday": bool(joining_agent and agent.id == joining_agent.id),
                }
                for agent in active_agents
            ],
            "packages": [
                {
                    "id": package.id,
                    "warehouse": package.warehouse_id,
                    "destination": list(package.destination),
                }
                for package in packages
            ],
        },
        "methodology": {
            "assignment_rule": "Nearest agent to package warehouse",
            "distance_metric": "Euclidean distance",
            "route": "Agent start → warehouse → package destination",
            "efficiency": "Total distance ÷ packages delivered (lower is better)",
            "tie_breaker": "Lexicographically smaller agent ID",
        },
        "events": {
            "random_delays_enabled": random_delays,
            "joining_agent": (
                {
                    "id": joining_agent.id,
                    "location": list(joining_agent.location),
                    "joined_after_packages": joins_after,
                }
                if joining_agent
                else None
            ),
        },
    }


def _rounded_assignment(assignment: Assignment) -> dict[str, Any]:
    row = asdict(assignment)
    for key in ("agent_start", "warehouse_location", "destination"):
        row[key] = list(row[key])
    for key in ("pickup_distance", "delivery_distance", "total_distance"):
        row[key] = round(row[key], 2)
    return row


def simulate_with_joining_agent(
    data: dict[str, Any],
    agent_id: str,
    location: Iterable[float],
    joins_after: int,
    **options: Any,
) -> dict[str, Any]:
    """Run a simulation where a new agent becomes available during the day."""
    agent = Agent(str(agent_id), _coordinate(location, "joining_agent.location"))
    return simulate(
        data,
        joining_agent=agent,
        joins_after=joins_after,
        **options,
    )


def render_ascii_routes(result: dict[str, Any], width: int = 61, height: int = 23) -> str:
    """Render the route network as a dependency-free ASCII map."""
    if width < 20 or height < 10:
        raise InputValidationError("ASCII map must be at least 20×10.")
    network = result["network"]
    coordinates = [
        item["location"] for item in network["warehouses"] + network["agents"]
    ] + [item["destination"] for item in network["packages"]]
    xs = [point[0] for point in coordinates]
    ys = [point[1] for point in coordinates]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)

    def project(point: Iterable[float]) -> tuple[int, int]:
        x, y = point
        px = round((x - min_x) / (max_x - min_x or 1) * (width - 1))
        py = height - 1 - round((y - min_y) / (max_y - min_y or 1) * (height - 1))
        return px, py

    grid = [[" " for _ in range(width)] for _ in range(height)]

    def draw_line(start: tuple[int, int], end: tuple[int, int], marker: str) -> None:
        x0, y0 = start
        x1, y1 = end
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        step_x = 1 if x0 < x1 else -1
        step_y = 1 if y0 < y1 else -1
        error = dx + dy
        while True:
            if grid[y0][x0] == " ":
                grid[y0][x0] = marker
            if (x0, y0) == (x1, y1):
                break
            doubled = 2 * error
            if doubled >= dy:
                error += dy
                x0 += step_x
            if doubled <= dx:
                error += dx
                y0 += step_y

    for route in result["assignments"]:
        draw_line(project(route["agent_start"]), project(route["warehouse_location"]), ":")
        draw_line(project(route["warehouse_location"]), project(route["destination"]), "·")
    for item in network["packages"]:
        x, y = project(item["destination"])
        grid[y][x] = "P"
    for item in network["agents"]:
        x, y = project(item["location"])
        grid[y][x] = "A"
    for item in network["warehouses"]:
        x, y = project(item["location"])
        grid[y][x] = "W"
    border = "+" + "-" * width + "+"
    body = "\n".join("|" + "".join(row) + "|" for row in grid)
    return f"{border}\n{body}\n{border}\nLegend: A agent  W warehouse  P destination  : pickup  · delivery"


def export_top_performer_csv(result: dict[str, Any], path: str | Path) -> Path:
    """Export the best agent to a one-row CSV file."""
    best_agent = result["summary"]["best_agent"]
    if best_agent is None:
        raise InputValidationError("Cannot export a top performer without deliveries.")
    metrics = result["agents"][best_agent]
    destination = Path(path)
    with destination.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(
            file,
            fieldnames=[
                "agent_id",
                "packages_delivered",
                "total_distance",
                "efficiency",
                "package_ids",
            ],
        )
        writer.writeheader()
        writer.writerow(
            {
                "agent_id": best_agent,
                "packages_delivered": metrics["packages_delivered"],
                "total_distance": metrics["total_distance"],
                "efficiency": metrics["efficiency"],
                "package_ids": "|".join(metrics["package_ids"]),
            }
        )
    return destination


def assign_packages(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Return package assignments for lightweight evaluator use."""
    return simulate(data)["assignments"]


def simulate_delivery(data: dict[str, Any]) -> dict[str, Any]:
    """Compatibility alias for the complete simulation."""
    return simulate(data)


def generate_report(data: dict[str, Any]) -> dict[str, Any]:
    """Return the rubric-style agent report plus best-agent field."""
    result = simulate(data)
    return {**result["agents"], "best_agent": result["summary"]["best_agent"]}


def available_cases() -> dict[str, Path]:
    """Discover supplied cases without allowing arbitrary file access."""
    cases = {"base_case.json": ROOT / "base_case.json"}
    if TEST_CASES_DIR.exists():
        for path in sorted(TEST_CASES_DIR.glob("*.json")):
            cases[path.name] = path
    return cases


app = Flask(__name__)


@app.get("/")
def index() -> str:
    return render_template("index.html")


@app.get("/api/health")
def health() -> Any:
    return jsonify({"status": "ok", "service": "FastBox simulation engine"})


@app.get("/api/cases")
def cases() -> Any:
    metadata = []
    for name, path in available_cases().items():
        try:
            warehouses, agents, packages = parse_input(load_json(path))
            metadata.append(
                {
                    "name": name,
                    "label": "Base case" if name == "base_case.json" else name.replace("_", " ").removesuffix(".json").title(),
                    "warehouses": len(warehouses),
                    "agents": len(agents),
                    "packages": len(packages),
                }
            )
        except InputValidationError:
            continue
    return jsonify({"cases": metadata})


@app.post("/api/simulate")
def api_simulate() -> Any:
    try:
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            raise InputValidationError("Request body must be a JSON object.")
        if "data" in payload:
            data = payload["data"]
            source = "Uploaded JSON"
        else:
            case_name = str(payload.get("case", "base_case.json"))
            case_path = available_cases().get(case_name)
            if case_path is None:
                raise InputValidationError("Unknown test case.")
            data = load_json(case_path)
            source = case_name
        options = payload.get("options", {})
        if not isinstance(options, dict):
            raise InputValidationError("'options' must be an object.")
        joining_agent_data = options.get("joining_agent")
        joining_agent = None
        if joining_agent_data is not None:
            if not isinstance(joining_agent_data, dict):
                raise InputValidationError("'joining_agent' must be an object.")
            joining_agent = Agent(
                str(joining_agent_data.get("id", "")).strip(),
                _coordinate(joining_agent_data.get("location"), "joining_agent.location"),
            )
            if not joining_agent.id:
                raise InputValidationError("Joining agent needs a non-empty 'id'.")
        result = simulate(
            data,
            random_delays=bool(options.get("random_delays", False)),
            seed=options.get("seed"),
            max_delay_minutes=int(options.get("max_delay_minutes", 45)),
            joining_agent=joining_agent,
            joins_after=int(options.get("joins_after", 0)),
        )
        return jsonify({"ok": True, "source": source, "result": result})
    except InputValidationError as error:
        return jsonify({"ok": False, "error": str(error)}), 400


def cli() -> int:
    parser = argparse.ArgumentParser(
        description="Assign FastBox packages to nearest agents and generate a report."
    )
    parser.add_argument(
        "input", nargs="?", default=str(ROOT / "base_case.json"), help="Input JSON file"
    )
    parser.add_argument(
        "-o",
        "--output",
        default="report.json",
        help="Report JSON destination (default: report.json)",
    )
    parser.add_argument("--compact", action="store_true", help="Print compact JSON")
    parser.add_argument(
        "--random-delays", action="store_true", help="Add reproducible random delays"
    )
    parser.add_argument("--seed", type=int, help="Random-delay seed")
    parser.add_argument(
        "--max-delay", type=int, default=45, help="Maximum delay in minutes"
    )
    parser.add_argument(
        "--join-agent",
        nargs=3,
        metavar=("ID", "X", "Y"),
        help="Add an agent during the day",
    )
    parser.add_argument(
        "--joins-after",
        type=int,
        default=0,
        help="Packages assigned before the new agent joins",
    )
    parser.add_argument(
        "--ascii", action="store_true", help="Print an ASCII route visualization"
    )
    parser.add_argument(
        "--top-performer-csv",
        nargs="?",
        const="top_performer.csv",
        help="Export the top performer to CSV",
    )
    parser.add_argument("--serve", action="store_true", help="Start the web dashboard")
    parser.add_argument("--host", default="127.0.0.1", help="Dashboard host")
    parser.add_argument("--port", type=int, default=5050, help="Dashboard port")
    args = parser.parse_args()

    if args.serve:
        app.run(host=args.host, port=args.port, debug=False)
        return 0

    try:
        joining_agent = (
            Agent(
                args.join_agent[0],
                _coordinate(
                    [float(args.join_agent[1]), float(args.join_agent[2])],
                    "joining_agent.location",
                ),
            )
            if args.join_agent
            else None
        )
        result = simulate(
            load_json(args.input),
            random_delays=args.random_delays,
            seed=args.seed,
            max_delay_minutes=args.max_delay,
            joining_agent=joining_agent,
            joins_after=args.joins_after,
        )
    except (InputValidationError, ValueError) as error:
        parser.error(str(error))
        return 2

    output = json.dumps(result, indent=None if args.compact else 2)
    print(output)
    brief_report = {
        **result["agents"],
        "best_agent": result["summary"]["best_agent"],
    }
    Path(args.output).write_text(
        json.dumps(brief_report, indent=2) + "\n", encoding="utf-8"
    )
    if args.ascii:
        print("\n" + render_ascii_routes(result))
    if args.top_performer_csv:
        export_top_performer_csv(result, args.top_performer_csv)
    return 0


if __name__ == "__main__":
    raise SystemExit(cli())
