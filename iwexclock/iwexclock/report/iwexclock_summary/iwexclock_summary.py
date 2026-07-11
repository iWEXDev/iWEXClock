import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, formatdate, getdate

# Fixed hierarchy: Project -> Task -> Todo -> User -> Period.
GROUP_FIELDS = ["project", "task", "todo", "user"]

DAY_EXPR = "DATE(start_time)"
WEEK_EXPR = "DATE(DATE_SUB(start_time, INTERVAL WEEKDAY(start_time) DAY))"
MONTH_EXPR = "DATE_FORMAT(start_time, '%%Y-%%m-01')"

# Each period mode expands into one or more grouping levels (fieldname, SQL expr),
# finest level last. Weekly adds a "day within the week" level so a week's total
# can be broken down day-by-day in the tree, not just shown as one lump sum.
PERIOD_LEVELS = {
    "Daily": [("period", DAY_EXPR)],
    "Weekly": [("period_week", WEEK_EXPR), ("period_day", DAY_EXPR)],
    "Monthly": [("period", MONTH_EXPR)],
}

LEVEL_LABELS = {
    "project": _("Project"),
    "task": _("Task"),
    "todo": _("Todo"),
    "user": _("User"),
}

# Unit separator: won't collide with real user/project/task names.
ID_SEP = "\x1f"


def execute(filters=None):
    filters = filters or {}
    period = filters.get("period") or "Daily"
    period_levels = PERIOD_LEVELS.get(period, PERIOD_LEVELS["Daily"])

    data = get_data(filters, GROUP_FIELDS, period_levels)
    attach_customer(data)
    columns = get_columns(period, period_levels)
    chart = get_chart(data, GROUP_FIELDS, period_levels)
    summary = get_summary(data)

    return columns, data, chart, summary


def attach_customer(rows):
    """Annotate each row with its Project's customer (display name), or None when the
    Project has no Customer linked. Not surfaced as a report column — it rides along on
    the row data for the print format's Customer column."""
    project_customer_map = get_project_customer_map(rows)
    for row in rows:
        row["customer"] = project_customer_map.get(row.get("project"))


@frappe.whitelist()
def get_tree_data(filters=None):
    """Nested Project -> Task -> Todo -> User -> Period tree with rolled-up totals,
    consumed by the custom HTML tree widget in iwexclock_summary.js."""
    filters = frappe.parse_json(filters) if isinstance(filters, str) else (filters or {})
    period = filters.get("period") or "Daily"
    period_levels = PERIOD_LEVELS.get(period, PERIOD_LEVELS["Daily"])

    leaf_rows = get_data(filters, GROUP_FIELDS, period_levels)
    project_customer_map = get_project_customer_map(leaf_rows)
    nodes, root_ids = build_tree(leaf_rows, GROUP_FIELDS, period_levels, project_customer_map)
    return nest_tree(nodes, root_ids, period)


def get_project_customer_map(leaf_rows):
    """project name -> customer's display name, for rows whose Project has a customer set."""
    project_names = {row["project"] for row in leaf_rows if row.get("project")}
    if not project_names:
        return {}

    projects = frappe.get_all(
        "Project",
        filters={"name": ["in", list(project_names)]},
        fields=["name", "customer"],
    )
    customer_names = {p["customer"] for p in projects if p.get("customer")}
    if not customer_names:
        return {}

    customers = frappe.get_all(
        "Customer",
        filters={"name": ["in", list(customer_names)]},
        fields=["name", "customer_name"],
    )
    customer_display = {c["name"]: c["customer_name"] for c in customers}

    return {
        p["name"]: customer_display.get(p["customer"], p["customer"])
        for p in projects
        if p.get("customer")
    }


def get_data(filters, group_fields, period_levels):
    conditions, values = get_conditions(filters)

    period_fields = [name for name, _expr in period_levels]
    select_fields = group_fields + [f"{expr} AS {name}" for name, expr in period_levels]
    group_by_fields = group_fields + period_fields

    select_clause = ",\n            ".join(select_fields)
    group_by_clause = ", ".join(group_by_fields)
    order_by_clause = ", ".join(period_fields + group_fields)

    query = f"""
        SELECT
            {select_clause},
            SUM(TIME_TO_SEC(duration)) AS total_seconds,
            COUNT(*) AS sessions
        FROM `tabiWEXClock Data`
        WHERE work_status = 'Active'
            AND duration IS NOT NULL AND duration != ''
            {conditions}
        GROUP BY {group_by_clause}
        ORDER BY {order_by_clause}
    """
    rows = frappe.db.sql(query, values, as_dict=True)

    for row in rows:
        row["total_seconds"] = cint(row.total_seconds)
        row["total_hours"] = flt(row["total_seconds"] / 3600.0, 2)
        row["total_duration"] = seconds_to_hms(row["total_seconds"])

    return rows


def get_conditions(filters):
    conditions = []
    values = {}

    if filters.get("from_date"):
        conditions.append("AND start_time >= %(from_date)s")
        values["from_date"] = f"{filters['from_date']} 00:00:00"

    if filters.get("to_date"):
        conditions.append("AND start_time <= %(to_date)s")
        values["to_date"] = f"{filters['to_date']} 23:59:59"

    if filters.get("user"):
        conditions.append("AND user = %(user)s")
        values["user"] = filters["user"]

    if filters.get("project"):
        conditions.append("AND project = %(project)s")
        values["project"] = filters["project"]

    if filters.get("task"):
        conditions.append("AND task = %(task)s")
        values["task"] = filters["task"]

    if filters.get("todo"):
        conditions.append("AND todo = %(todo)s")
        values["todo"] = filters["todo"]

    if filters.get("customer"):
        # iWEXClock Data has no customer column of its own — a Customer is
        # reached via Project, so filter by whichever Projects belong to it.
        customer_projects = frappe.get_all(
            "Project", filters={"customer": filters["customer"]}, pluck="name"
        )
        if customer_projects:
            conditions.append("AND project IN %(customer_projects)s")
            values["customer_projects"] = tuple(customer_projects)
        else:
            # Customer has no Projects at all: no rows can possibly match.
            conditions.append("AND 1=0")

    return "\n            ".join(conditions), values


# Project/Task/Todo/User filter dropdowns are wired (see iwexclock_summary.js)
# to these instead of the plain Project/Task/ToDo/User doctype search, so each
# dropdown only offers values that actually appear in iWEXClock Data together
# with whatever other top filters are already selected — picking a Customer
# narrows Project's options to that customer's projects, picking a Project
# further narrows Task's options to that project's tasks, and so on down to
# User. This has to query iWEXClock Data directly rather than lean on the
# doctypes' own link relationships, because e.g. ToDo has no field linking it
# back to Task or Project at all — only iWEXClock Data's own project/task/todo
# columns do.
LINK_QUERY_FIELDS = {"project", "task", "todo", "user"}


def _link_query(fieldname, txt, filters, page_len):
    filters = frappe.parse_json(filters) if isinstance(filters, str) else (filters or {})
    other_filters = {k: v for k, v in filters.items() if k != fieldname}
    conditions, values = get_conditions(other_filters)

    values["txt"] = f"%{txt}%"
    query = f"""
        SELECT DISTINCT {fieldname}
        FROM `tabiWEXClock Data`
        WHERE work_status = 'Active'
            AND duration IS NOT NULL AND duration != ''
            AND {fieldname} IS NOT NULL AND {fieldname} != ''
            AND {fieldname} LIKE %(txt)s
            {conditions}
        ORDER BY {fieldname}
        LIMIT {cint(page_len) or 20}
    """
    return frappe.db.sql(query, values)


@frappe.whitelist()
def project_query(doctype, txt, searchfield, start, page_len, filters=None, **kwargs):
    return _link_query("project", txt, filters, page_len)


@frappe.whitelist()
def task_query(doctype, txt, searchfield, start, page_len, filters=None, **kwargs):
    return _link_query("task", txt, filters, page_len)


@frappe.whitelist()
def todo_query(doctype, txt, searchfield, start, page_len, filters=None, **kwargs):
    return _link_query("todo", txt, filters, page_len)


@frappe.whitelist()
def user_query(doctype, txt, searchfield, start, page_len, filters=None, **kwargs):
    return _link_query("user", txt, filters, page_len)


def build_tree(leaf_rows, group_fields, period_levels, project_customer_map=None):
    """Fold flat leaf rows (grouped by group_fields + period levels) into a node tree,
    rolling total_seconds/sessions up into every ancestor along the way."""
    project_customer_map = project_customer_map or {}
    period_fields = [name for name, _expr in period_levels]
    level_fields = group_fields + period_fields
    nodes = {}
    root_ids = []

    for row in leaf_rows:
        path_values = [row[field] for field in group_fields] + [row[field] for field in period_fields]
        parent_id = None
        id_parts = []

        for level_index, raw_value in enumerate(path_values):
            id_parts.append(str(raw_value))
            node_id = ID_SEP.join(id_parts)
            field = level_fields[level_index]

            node = nodes.get(node_id)
            if node is None:
                node = {
                    "name": node_id,
                    "parent": parent_id,
                    "field": field,
                    "raw_value": raw_value,
                    "total_seconds": 0,
                    "sessions": 0,
                    "children": [],
                }
                if field == "project":
                    node["customer"] = project_customer_map.get(raw_value)
                nodes[node_id] = node
                if parent_id is None:
                    root_ids.append(node_id)
                else:
                    nodes[parent_id]["children"].append(node_id)

            node["total_seconds"] += row["total_seconds"]
            node["sessions"] += row["sessions"]
            parent_id = node_id

    return nodes, root_ids


def nest_tree(nodes, root_ids, period):
    period_fields = {name for name, _expr in PERIOD_LEVELS.get(period, PERIOD_LEVELS["Daily"])}

    def sort_key(node_id):
        node = nodes[node_id]
        if node["field"] in period_fields:
            return node["raw_value"] or ""
        return (format_label(node, period) or "").lower()

    def build(node_id):
        node = nodes[node_id]
        # Raw chronological value for period/week/day nodes, so the front-end's
        # "Sort By: Name" option can order these by date rather than by the
        # formatted label string (which doesn't sort chronologically as text).
        is_period_node = node["field"] in period_fields
        sort_value = str(node["raw_value"]) if is_period_node and node["raw_value"] else None
        return {
            "id": node["name"],
            "field": node["field"],
            "label": format_label(node, period),
            "sort_value": sort_value,
            "total_duration": seconds_to_hms(node["total_seconds"]),
            "total_hours": flt(node["total_seconds"] / 3600.0, 2),
            "sessions": node["sessions"],
            "children": [build(child_id) for child_id in sorted(node["children"], key=sort_key)],
        }

    return [build(root_id) for root_id in sorted(root_ids, key=sort_key)]


def format_label(node, period):
    field = node["field"]
    value = node["raw_value"]

    if field == "period_week":
        return format_week_label(value)
    if field == "period_day":
        return format_day_label(value)
    if field == "period":
        return format_month_label(value) if period == "Monthly" else format_day_label(value)

    if not value:
        return _("(No {0})").format(LEVEL_LABELS.get(field, field.title()))

    label = str(value)
    if field == "project" and node.get("customer"):
        label = f"{label} : {node['customer']}"
    return label


def format_day_label(value):
    if not value:
        return _("(Unknown Date)")
    return formatdate(getdate(value))


def format_week_label(value):
    if not value:
        return _("(Unknown Week)")
    start = getdate(value)
    end = add_days(start, 6)
    return _("Week of {0} to {1}").format(formatdate(start), formatdate(end))


def format_month_label(value):
    if not value:
        return _("(Unknown Month)")
    return getdate(value).strftime("%B %Y")


def get_columns(period, period_levels):
    label_map = {
        "project": ("Project", "Link", "Project", 150),
        "task": ("Task", "Link", "Task", 150),
        "todo": ("Todo", "Link", "ToDo", 150),
        "user": ("User", "Link", "User", 150),
    }

    columns = []
    for field in GROUP_FIELDS:
        label, fieldtype, options, width = label_map[field]
        col = {"label": _(label), "fieldname": field, "fieldtype": fieldtype, "width": width}
        if options:
            col["options"] = options
        columns.append(col)

    period_column_labels = {
        "period": _("Month") if period == "Monthly" else _("Date"),
        "period_week": _("Week Starting"),
        "period_day": _("Date"),
    }
    for field_name, _expr in period_levels:
        columns.append({
            "label": period_column_labels[field_name],
            "fieldname": field_name,
            "fieldtype": "Date",
            "width": 100,
        })

    columns.append({"label": _("Total Duration"), "fieldname": "total_duration", "fieldtype": "Data", "width": 120})
    columns.append({"label": _("Total Hours"), "fieldname": "total_hours", "fieldtype": "Float", "precision": 2, "width": 100})
    columns.append({"label": _("Sessions"), "fieldname": "sessions", "fieldtype": "Int", "width": 90})

    return columns


def get_chart(data, group_fields, period_levels):
    if "project" not in group_fields or not data:
        return None

    period_field = period_levels[0][0]

    periods = sorted({row[period_field] for row in data})
    projects = sorted({row["project"] for row in data if row["project"]})

    series = []
    for project in projects:
        values = []
        for p in periods:
            matches = [r for r in data if r[period_field] == p and r["project"] == project]
            values.append(sum(m["total_hours"] for m in matches))
        series.append({"name": project, "values": values})

    return {
        "data": {"labels": [str(p) for p in periods], "datasets": series},
        "type": "bar",
        "fieldtype": "Float",
    }


def get_summary(data):
    total_hours = sum(row["total_hours"] for row in data)
    return [{
        "label": _("Total Hours (Active)"),
        "value": round(total_hours, 2),
        "indicator": "Green",
        "datatype": "Float",
    }]


def seconds_to_hms(seconds):
    h, remainder = divmod(int(seconds), 3600)
    m, s = divmod(remainder, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"
