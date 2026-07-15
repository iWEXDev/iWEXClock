const IWEXCLOCK_TREE_METHOD =
	"iwexclock.iwexclock.report.iwexclock_summary.iwexclock_summary.get_tree_data";
const IWEXCLOCK_PIVOT_METHOD =
	"iwexclock.iwexclock.report.iwexclock_summary.iwexclock_summary.get_project_month_pivot";
const IWEXCLOCK_TREE_INITIAL_EXPAND_DEPTH = 1;

let iwexclock_active_report = null;

// The whole nested tree comes down from the server in one call (see
// HOW_THIS_REPORT_WORKS.md). Sort By re-derives what's on screen from this
// cached copy instead of round-tripping to the server, same as
// expand/collapse already does. Filtering by row content (Project/Task/Todo/
// User/Date) is handled entirely by the top filter bar above, which re-fetches
// from the server — there's deliberately no second, separate filter UI here.
let iwexclock_tree_raw_data = [];
let iwexclock_tree_state = {
	sort_by: "name", // "name" | "duration" | "sessions"
	sort_dir: "asc", // "asc" | "desc"
};

// Guards against the recursive on_change calls that would otherwise happen
// when our own code calls .set_value() on the from_date/to_date filters —
// see iwexclock_sync_dates_to_period() for why this is needed.
let iwexclock_syncing_dates = false;

// Drives the Expand All / Collapse All toggle button. false renders every
// node at its normal default depth (IWEXCLOCK_TREE_INITIAL_EXPAND_DEPTH) —
// the same state the tree is in on first load — true forces every node open
// regardless of depth. There's no third "collapse everything" state: clicking
// Collapse All puts the tree back to the default (partially expanded) state,
// not fully closed.
let iwexclock_tree_all_expanded = false;
let iwexclock_expand_all_btn = null;

// frappe.Chart instance backing the chart above the pivot table. Tracked
// only so its container can be safely re-rendered on every pivot refresh or
// graph-type change (frappe.Chart has no destroy() — see
// iwexclock_render_pivot_chart).
let iwexclock_pivot_chart = null;

// User's current graph-type pick from the toolbar selector (see onload()).
// Persists across refreshes within the session, same as Sort By and Expand
// All state, so switching filters doesn't silently reset it back to Bar.
let iwexclock_pivot_chart_type = "Bar"; // "Bar" | "Line" | "Pie"

// Last months/projects arrays rendered into the pivot (see
// iwexclock_render_pivot_table). Cached so the graph-type selector can
// re-render the chart instantly from data already on the client instead of
// re-fetching from the server, same principle as Sort By re-deriving the
// tree from iwexclock_tree_raw_data.
let iwexclock_pivot_months = [];
let iwexclock_pivot_projects = [];

// Fixed category order for the pivot chart's project series, reused from
// Frappe's own named chart palette (see user_profile_controller.js) rather
// than inventing new colors — projects are assigned hues in this order and
// never cycled based on filter state, so a given project keeps its color
// across refreshes as long as it stays within the first 10.
const IWEXCLOCK_CHART_COLORS = [
	"blue",
	"green",
	"orange",
	"red",
	"purple",
	"cyan",
	"yellow",
	"pink",
	"light-blue",
	"grey",
];

frappe.query_reports["iWEXClock Summary"] = {
	filters: [
		{
			fieldname: "from_date",
			label: "From Date",
			fieldtype: "Date",
			on_change: (report) => iwexclock_sync_dates_to_period(report),
		},
		{
			fieldname: "to_date",
			label: "To Date",
			fieldtype: "Date",
		},
		{
			fieldname: "period",
			label: "Period",
			fieldtype: "Select",
			options: "Daily\nWeekly\nMonthly",
			default: "Daily",
			on_change: (report) => iwexclock_sync_dates_to_period(report),
		},
		{
			fieldname: "user",
			label: "User",
			fieldtype: "Link",
			options: "User",
			get_query: () => iwexclock_link_query("user"),
		},
		{
			fieldname: "customer",
			label: "Customer",
			fieldtype: "Link",
			options: "Customer",
		},
		{
			fieldname: "project",
			label: "Project",
			fieldtype: "Link",
			options: "Project",
			get_query: () => iwexclock_link_query("project"),
		},
		{
			fieldname: "task",
			label: "Task",
			fieldtype: "Link",
			options: "Task",
			get_query: () => iwexclock_link_query("task"),
		},
		{
			fieldname: "todo",
			label: "Todo",
			fieldtype: "Link",
			options: "ToDo",
			get_query: () => iwexclock_link_query("todo"),
		},
	],

	onload(report) {
		iwexclock_active_report = report;
		iwexclock_inject_tree_styles();
		iwexclock_get_tree_container(report);
		// Neither date has a default anymore (see filters above), so there's
		// nothing to snap/correct on a fresh load — just set To Date's initial
		// enabled/disabled state to match the default Period ("Daily"). This
		// is UI-only (no data fetch), unlike the full iwexclock_sync_dates_to_period().
		iwexclock_apply_period_ui(report);
		iwexclock_add_chart_type_selector(report);
		// add_button() (as opposed to add_inner_button() or add_menu_item())
		// drops the button into custom-actions, which sits immediately left of
		// the standard Actions button in the page toolbar — i.e. right next to
		// it, not buried inside its "..." dropdown menu.
		report.page.add_button(__("Clear Filters"), () => iwexclock_clear_all_filters(report), {
			icon: "filter",
		});
		iwexclock_expand_all_btn = report.page.add_button(
			__("Expand All"),
			() => iwexclock_toggle_expand_all(report),
			{ icon: "expand" }
		);
		// iwexclock_tree_all_expanded (like Sort By's state) persists across
		// re-opens of this report within the same session — sync the freshly
		// (re)created button's label/icon to whatever it's already set to
		// rather than forcing it back to collapsed.
		iwexclock_update_expand_all_button();
	},

	after_datatable_render() {
		if (!iwexclock_active_report) return;
		iwexclock_refresh_tree(iwexclock_active_report);
	},
};

// Points the Project/Task/Todo/User filter dropdowns at the matching
// *_query() function in the .py file instead of the plain Project/Task/ToDo/
// User doctype search, and passes along whatever else is currently selected
// in the top filter bar (date range, Customer, and the other three of these
// four fields) as `filters` — so each dropdown only offers values that
// actually appear in iWEXClock Data together with the current selection.
// E.g. picking a Customer narrows Project's options to that customer's
// projects; picking a Project further narrows Task's (and User's) options to
// that project's data. iwexclock_active_report is read fresh on every call
// (this only runs when the user opens that dropdown), so it always reflects
// whatever's selected at that moment, not what was selected when the report
// first loaded.
function iwexclock_link_query(fieldname) {
	return {
		query: `iwexclock.iwexclock.report.iwexclock_summary.iwexclock_summary.${fieldname}_query`,
		filters: iwexclock_active_report ? iwexclock_active_report.get_filter_values() : {},
	};
}

// Returns [from, to] (both "YYYY-MM-DD") for the Daily/Weekly/Monthly bucket
// that contains anchor_date, so the filter range always matches exactly one
// of the buckets get_tree_data() groups rows into (see PERIOD_LEVELS in the
// .py file) — Weekly uses an ISO (Monday-start) week, same as WEEK_EXPR
// there, so a "week" here is never a partial one.
function iwexclock_period_bounds(period, anchor_date) {
	if (period === "Weekly") {
		const start = moment(anchor_date, "YYYY-MM-DD").startOf("isoWeek");
		return [start.format("YYYY-MM-DD"), moment(start).add(6, "days").format("YYYY-MM-DD")];
	}
	if (period === "Monthly") {
		const start = moment(anchor_date, "YYYY-MM-DD").startOf("month");
		return [start.format("YYYY-MM-DD"), moment(start).endOf("month").format("YYYY-MM-DD")];
	}
	// Daily: a single day, both ends the same.
	return [anchor_date, anchor_date];
}

// Toggles whether To Date can be edited directly. Daily always shows exactly
// one day, so To Date is locked to mirror From Date and disabled; Weekly and
// Monthly leave both dates editable (per iwexclock_period_bounds(), changing
// From Date still snaps both to the containing week/month).
function iwexclock_apply_period_ui(report) {
	const period = report.get_filter_value("period") || "Daily";
	const to_date_filter = report.get_filter("to_date");
	to_date_filter.df.read_only = period === "Daily" ? 1 : 0;
	to_date_filter.refresh();
}

// Recomputes From Date/To Date from whichever one is authoritative (From
// Date) whenever Period or From Date changes, and keeps To Date's
// enabled/disabled state and value in sync (including clearing it when From
// Date is cleared, since a stale To Date left over from before would
// silently widen the query range instead of showing nothing). Neither date
// is mandatory — with From Date cleared (in any Period mode), the report
// shows all data unfiltered by date, same as opening any other doctype's
// list/report without picking a date range first.
//
// This is async and every set_value() call below is awaited deliberately:
// a Frappe control's set_value() doesn't update its value synchronously —
// frappe.run_serially() (see frappe/public/js/frappe/dom.js) chains the
// actual model update and the on_change callback as promise .then() steps,
// so the real value lands on a later microtask. Calling report.refresh(true)
// right after set_value() without awaiting it reads the *old* filter values
// (the update hasn't landed yet), which used to send the previous date range
// to the server while the UI already showed the newly picked date — the
// exact "I picked a date with no data, but it still shows data" bug.
//
// Calling set_value() below re-triggers From Date's own on_change (it's a
// real value change, not a no-op) — the iwexclock_syncing_dates guard makes
// that re-entrant call a no-op instead of recomputing a second time.
// report._no_refresh is held true throughout so neither field's default
// per-field refresh fires early; iwexclock_sync_dates_to_period triggers
// exactly one refresh itself, after both dates are confirmed committed.
async function iwexclock_sync_dates_to_period(report) {
	if (iwexclock_syncing_dates) return;

	const period = report.get_filter_value("period") || "Daily";
	const from_date = report.get_filter_value("from_date");

	iwexclock_syncing_dates = true;
	report._no_refresh = true;

	if (!from_date) {
		await report.get_filter("to_date").set_value(null);
	} else {
		const [new_from, new_to] = iwexclock_period_bounds(period, from_date);
		await report.get_filter("from_date").set_value(new_from);
		await report.get_filter("to_date").set_value(new_to);
	}

	report._no_refresh = false;
	iwexclock_syncing_dates = false;

	iwexclock_apply_period_ui(report);
	report.refresh(true);
}

const IWEXCLOCK_FILTER_FIELDNAMES = [
	"from_date",
	"to_date",
	"user",
	"customer",
	"project",
	"task",
	"todo",
];

// "Clear Filters" menu action (see onload()). Resets every filter to empty
// and Period back to its default ("Daily"), then refreshes exactly once.
// Reuses the same iwexclock_syncing_dates / report._no_refresh guards as
// iwexclock_sync_dates_to_period() for the same reason: from_date and period
// both have their own on_change that would otherwise fire mid-clear (from_date
// empty is already a no-op there, but holding the guard avoids relying on
// that and keeps this resilient if that function's early-return logic ever
// changes) and each individual set_value() below needs to be awaited before
// the next one runs, for the same "value isn't committed synchronously"
// reason explained on iwexclock_sync_dates_to_period().
async function iwexclock_clear_all_filters(report) {
	iwexclock_syncing_dates = true;
	report._no_refresh = true;

	for (const fieldname of IWEXCLOCK_FILTER_FIELDNAMES) {
		await report.get_filter(fieldname).set_value(null);
	}
	await report.get_filter("period").set_value("Daily");

	report._no_refresh = false;
	iwexclock_syncing_dates = false;

	iwexclock_apply_period_ui(report);
	report.refresh(true);
}

// Bar/Line/Pie selector for the chart above the pivot table, placed to the
// left of Clear Filters. report.page.add_field()'s container (page_form) is
// a separate row in the page body, not the toolbar (custom-actions) that
// add_button() uses — so a Select field can't be positioned relative to
// Clear Filters that way. Building a plain <select> directly inside
// custom_actions (the same container add_button() appends to) and
// prepending it before Clear Filters is added keeps it to the left, and
// matches add_select()'s own approach of using a raw <select> rather than a
// full frappe.ui.form control for a toolbar-level dropdown.
function iwexclock_add_chart_type_selector(report) {
	if (report.page.custom_actions.find(".iwexclock-chart-type-select").length) return;

	const $select = $(`
		<select class="form-control input-xs iwexclock-chart-type-select" title="${__("Graph Type")}">
			<option value="Bar">${__("Bar")}</option>
			<option value="Line">${__("Line")}</option>
			<option value="Pie">${__("Pie")}</option>
		</select>
	`).prependTo(report.page.custom_actions);
	report.page.custom_actions.removeClass("hide");

	$select.val(iwexclock_pivot_chart_type).on("change", () => {
		iwexclock_pivot_chart_type = $select.val();
		const $container = iwexclock_get_tree_container(report);
		iwexclock_render_pivot_chart(
			iwexclock_pivot_months,
			iwexclock_pivot_projects,
			$container.find("#iwexclock-pivot-table")
		);
	});
}

function iwexclock_get_tree_container(report) {
	// query_report.js calls this.$report.show() unconditionally right after
	// render_datatable() on every refresh, so a plain .hide() call here always
	// loses that race. Force it hidden with a stylesheet !important rule instead,
	// which beats jQuery's non-important inline style regardless of call order.
	report.$report.addClass("iwexclock-native-table-hidden");

	let $container = report.page.main.find("#iwexclock-timesheet-tree");
	if (!$container.length) {
		$container = $('<div id="iwexclock-timesheet-tree" class="iwexclock-tree-wrapper"></div>');
		report.$report.after($container);
	}

	// The toolbar (Sort By) is built once and left alone on subsequent
	// refreshes so its controls aren't reset every time the top filters
	// change. Only the #iwexclock-tree-body div underneath gets rewritten
	// per refresh. iwexclock_get_pivot_table() is created after the toolbar
	// but prepends itself, so on first build it ends up above the toolbar
	// (pivot table, then toolbar, then tree body) — see that function.
	iwexclock_get_tree_toolbar($container);
	iwexclock_get_pivot_table($container);
	if (!$container.find("#iwexclock-tree-body").length) {
		$container.append('<div id="iwexclock-tree-body"></div>');
	}

	return $container;
}

// Project x Month pivot table, shown above Sort By. Built once (like the
// toolbar) and left alone on subsequent refreshes — only its contents are
// rewritten per refresh, by iwexclock_render_pivot_table().
function iwexclock_get_pivot_table($container) {
	let $pivot = $container.find("#iwexclock-pivot-table");
	if ($pivot.length) return $pivot;

	$pivot = $('<div id="iwexclock-pivot-table"></div>');
	$container.prepend($pivot);
	return $pivot;
}

function iwexclock_get_tree_toolbar($container) {
	let $toolbar = $container.find("#iwexclock-tree-toolbar");
	if ($toolbar.length) return $toolbar;

	$toolbar = $(`
		<div id="iwexclock-tree-toolbar" class="iwexclock-tree-toolbar">
			<div class="iwexclock-tree-toolbar-group">
				<span class="iwexclock-tree-toolbar-label">${__("Sort By")}</span>
				<select class="iwexclock-tree-sort-by form-control">
					<option value="name">${__("Name")}</option>
					<option value="duration">${__("Duration")}</option>
					<option value="sessions">${__("Sessions")}</option>
				</select>
				<select class="iwexclock-tree-sort-dir form-control">
					<option value="asc">${__("Ascending")}</option>
					<option value="desc">${__("Descending")}</option>
				</select>
			</div>
		</div>
	`);
	$container.prepend($toolbar);

	const rerender = () => iwexclock_render_tree_from_state($container.find("#iwexclock-tree-body"));

	$toolbar
		.find(".iwexclock-tree-sort-by")
		.val(iwexclock_tree_state.sort_by)
		.on("change", function () {
			iwexclock_tree_state.sort_by = $(this).val();
			rerender();
		});

	$toolbar
		.find(".iwexclock-tree-sort-dir")
		.val(iwexclock_tree_state.sort_dir)
		.on("change", function () {
			iwexclock_tree_state.sort_dir = $(this).val();
			rerender();
		});

	return $toolbar;
}

// Toggles between forcing every node open ("Expand All") and the default
// depth-based render ("Collapse All" reverts to it — see
// iwexclock_tree_all_expanded above). Re-renders from the already-cached raw
// data, same as Sort By, so this doesn't hit the server.
function iwexclock_toggle_expand_all(report) {
	iwexclock_tree_all_expanded = !iwexclock_tree_all_expanded;
	iwexclock_update_expand_all_button();

	const $container = iwexclock_get_tree_container(report);
	iwexclock_render_tree_from_state($container.find("#iwexclock-tree-body"));
}

function iwexclock_update_expand_all_button() {
	if (!iwexclock_expand_all_btn) return;

	const label = iwexclock_tree_all_expanded ? __("Collapse All") : __("Expand All");
	const icon = iwexclock_tree_all_expanded ? "collapse" : "expand";
	iwexclock_expand_all_btn.html(`${frappe.utils.icon(icon)} ${label}`);
}

function iwexclock_refresh_tree(report) {
	const $container = iwexclock_get_tree_container(report);
	const $body = $container.find("#iwexclock-tree-body");
	const $pivot = $container.find("#iwexclock-pivot-table");
	// Neither date filter is mandatory (see the filters array above) — with
	// both empty, get_conditions() in the .py file simply adds no date
	// condition at all, so this fetches all data unfiltered by date, same as
	// opening the report fresh or clearing every other filter.
	const filters = report.get_filter_values();

	$body.html(`<div class="text-muted iwexclock-tree-loading">${__("Loading")}...</div>`);
	$pivot.html(`<div class="text-muted iwexclock-tree-loading">${__("Loading")}...</div>`);

	frappe.call({
		method: IWEXCLOCK_TREE_METHOD,
		args: { filters },
		callback: (r) => {
			iwexclock_tree_raw_data = r.message || [];
			iwexclock_render_tree_from_state($body);
		},
	});

	// Separate call (rather than piggybacking on get_tree_data's response)
	// since the pivot is grouped Project x Month only, independent of the
	// Project -> Task -> Todo -> User -> Period tree shape and of the Period
	// filter's Daily/Weekly/Monthly bucketing.
	frappe.call({
		method: IWEXCLOCK_PIVOT_METHOD,
		args: { filters },
		callback: (r) => {
			iwexclock_render_pivot_table(r.message || {}, $pivot);
		},
	});
}

function iwexclock_render_pivot_table(data, $pivot) {
	const months = data.months || [];
	const projects = data.projects || [];

	if (!months.length || !projects.length) {
		iwexclock_pivot_months = [];
		iwexclock_pivot_projects = [];
		$pivot.html(`<div class="text-muted iwexclock-tree-empty">${__("No Data")}</div>`);
		return;
	}

	const month_headers = months
		.map((m) => `<th>${frappe.utils.escape_html(m.label)}</th>`)
		.join("");

	const project_rows = projects
		.map((p) => {
			const cells = p.hours.map((h) => `<td>${Number(h).toFixed(2)}</td>`).join("");
			return `
				<tr>
					<td class="iwexclock-pivot-row-label">${frappe.utils.escape_html(p.label)}</td>
					${cells}
					<td class="iwexclock-pivot-total-col">${Number(p.total_hours).toFixed(2)}</td>
				</tr>`;
		})
		.join("");

	const month_total_cells = (data.month_totals || [])
		.map((h) => `<td>${Number(h).toFixed(2)}</td>`)
		.join("");

	$pivot.html(`
		<div id="iwexclock-pivot-chart"></div>
		<table class="iwexclock-pivot-table">
			<thead>
				<tr>
					<th class="iwexclock-pivot-corner">${__("Project")}</th>
					${month_headers}
					<th class="iwexclock-pivot-total-col">${__("Total")}</th>
				</tr>
			</thead>
			<tbody>
				${project_rows}
				<tr class="iwexclock-pivot-totals-row">
					<td class="iwexclock-pivot-row-label">${__("Total Hrs")}</td>
					${month_total_cells}
					<td class="iwexclock-pivot-total-col">${Number(data.grand_total || 0).toFixed(2)}</td>
				</tr>
			</tbody>
		</table>
	`);

	// Cached so the toolbar's chart-type selector (see
	// iwexclock_add_chart_type_selector) can re-render the chart on its own,
	// without a server round-trip, the same way Sort By re-derives the tree
	// from iwexclock_tree_raw_data.
	iwexclock_pivot_months = months;
	iwexclock_pivot_projects = projects;
	iwexclock_render_pivot_chart(months, projects, $pivot);
}

// Chart above the pivot table, in whichever type the toolbar selector is
// currently set to (see iwexclock_pivot_chart_type / iwexclock_add_chart_type_selector).
// Bar and Line both plot every project across every month, straight from the
// same months/projects arrays the table renders from, so the chart and table
// can never disagree. Pie has no time axis, so it instead plots each
// project's total_hours — the one number a pie can meaningfully show.
function iwexclock_render_pivot_chart(months, projects, $pivot) {
	const $chart_container = $pivot.find("#iwexclock-pivot-chart");
	if (!$chart_container.length) return;

	const tooltip_hours = { formatTooltipY: (value) => `${Number(value).toFixed(2)} ${__("hrs")}` };

	let options;
	if (iwexclock_pivot_chart_type === "Pie") {
		options = {
			type: "pie",
			height: 240,
			colors: IWEXCLOCK_CHART_COLORS,
			tooltipOptions: tooltip_hours,
			data: {
				labels: projects.map((p) => p.label),
				datasets: [{ values: projects.map((p) => p.total_hours) }],
			},
		};
	} else {
		options = {
			type: iwexclock_pivot_chart_type === "Line" ? "line" : "bar",
			height: 240,
			colors: IWEXCLOCK_CHART_COLORS,
			barOptions: { stacked: 1, spaceRatio: 0.3 },
			axisOptions: {
				shortenYAxisNumbers: 1,
				numberFormatter: frappe.utils.format_chart_axis_number,
			},
			tooltipOptions: tooltip_hours,
			data: {
				labels: months.map((m) => m.label),
				datasets: projects.map((p) => ({ name: p.label, values: p.hours })),
			},
		};
	}

	// frappe.Chart has no destroy(); the container is either fresh (initial
	// render, via $pivot.html() above) or about to have its chart swapped for
	// a type change (selector's change handler) — .empty() covers both so a
	// stale instance never lingers underneath the new one.
	$chart_container.empty();
	iwexclock_pivot_chart = new frappe.Chart($chart_container[0], options);
}

// Re-derives the on-screen tree from the cached raw data plus whatever Sort
// By is currently set to. No server round-trip — same principle as
// expand/collapse (see HOW_THIS_REPORT_WORKS.md).
function iwexclock_render_tree_from_state($body) {
	const state = iwexclock_tree_state;
	const sorted = iwexclock_apply_sort(iwexclock_tree_raw_data, state.sort_by, state.sort_dir);
	iwexclock_render_tree(sorted, $body);
}

function iwexclock_sort_compare(a, b, sort_by) {
	if (sort_by === "duration") return a.total_hours - b.total_hours;
	if (sort_by === "sessions") return a.sessions - b.sessions;

	// "name": period/week/day nodes carry a raw chronological sort_value
	// (see nest_tree() in the .py file) because their formatted labels
	// (e.g. "15-06-2026") don't sort correctly as plain text.
	if (a.sort_value != null && b.sort_value != null) {
		if (a.sort_value < b.sort_value) return -1;
		if (a.sort_value > b.sort_value) return 1;
		return 0;
	}
	return (a.label || "").toLowerCase().localeCompare((b.label || "").toLowerCase());
}

function iwexclock_apply_sort(nodes, sort_by, sort_dir) {
	const dir = sort_dir === "desc" ? -1 : 1;
	return nodes
		.map((node) => ({
			...node,
			children:
				node.children && node.children.length
					? iwexclock_apply_sort(node.children, sort_by, sort_dir)
					: node.children,
		}))
		.sort((a, b) => iwexclock_sort_compare(a, b, sort_by) * dir);
}

function iwexclock_render_tree(nodes, $body) {
	if (!nodes.length) {
		$body.html(`<div class="text-muted iwexclock-tree-empty">${__("No Data")}</div>`);
		return;
	}

	const header = `
		<div class="iwexclock-tree-row iwexclock-tree-header">
			<span class="iwexclock-tree-label">${__("Name")}</span>
			<span class="iwexclock-tree-meta">
				<span class="iwexclock-tree-duration">${__("Duration")}</span>
				<span class="iwexclock-tree-hours">${__("Hours")}</span>
				<span class="iwexclock-tree-sessions">${__("Sessions")}</span>
			</span>
		</div>`;

	const body = nodes.map((node) => iwexclock_render_node(node, 0)).join("");
	$body.html(`<div class="iwexclock-tree">${header}${body}</div>`);

	$body.off("click.iwexclock-tree").on("click.iwexclock-tree", ".iwexclock-tree-toggle", (e) => {
		const $toggle = $(e.currentTarget);
		const $node = $toggle.closest(".iwexclock-tree-node");
		const $children = $node.children(".iwexclock-tree-children");
		if (!$children.length) return;

		const expanded = $children.is(":visible");
		$children.toggle(!expanded);
		$toggle.html(iwexclock_toggle_icon($node.attr("data-field"), !expanded));
	});
}

function iwexclock_render_node(node, depth) {
	const has_children = node.children && node.children.length;
	const expanded = iwexclock_tree_all_expanded || depth < IWEXCLOCK_TREE_INITIAL_EXPAND_DEPTH;

	const toggle_html = has_children
		? `<span class="iwexclock-tree-toggle">${iwexclock_toggle_icon(node.field, expanded)}</span>`
		: `<span class="iwexclock-tree-toggle iwexclock-tree-toggle-empty"></span>`;

	const children_html = has_children
		? `<div class="iwexclock-tree-children" style="display: ${expanded ? "block" : "none"}">
			${node.children.map((child) => iwexclock_render_node(child, depth + 1)).join("")}
		</div>`
		: "";

	return `
		<div class="iwexclock-tree-node" data-field="${frappe.utils.escape_html(node.field)}">
			<div class="iwexclock-tree-row" style="padding-left: ${depth * 22}px">
				${toggle_html}
				<span class="iwexclock-tree-label">${frappe.utils.escape_html(node.label)}</span>
				<span class="iwexclock-tree-meta">
					<span class="iwexclock-tree-duration">${node.total_duration}</span>
					<span class="iwexclock-tree-hours">${Number(node.total_hours).toFixed(2)}h</span>
					<span class="iwexclock-tree-sessions">${node.sessions} ${__("sessions")}</span>
				</span>
			</div>
			${children_html}
		</div>`;
}

function iwexclock_toggle_icon(field, expanded) {
	// Match the icon language of Frappe's own tree views (frappe.ui.Tree, used for
	// Item Group / Territory / Chart of Accounts): folder for branch nodes with real
	// children, a document icon for single "pages", a pen for editable leaf records.
	// User/Period rows keep the generic chevron since they're just grouping buckets.
	if (field === "project") {
		return frappe.utils.icon(expanded ? "folder-open" : "folder-normal", "sm");
	}
	if (field === "task") {
		return frappe.utils.icon("file", "sm");
	}
	if (field === "todo") {
		return frappe.utils.icon("edit", "sm");
	}
	return frappe.utils.icon(expanded ? "es-small-down" : "es-small-right", "sm");
}

function iwexclock_inject_tree_styles() {
	if (document.getElementById("iwexclock-timesheet-tree-styles")) return;

	const style = document.createElement("style");
	style.id = "iwexclock-timesheet-tree-styles";
	style.textContent = `
		.iwexclock-native-table-hidden { display: none !important; }
		.iwexclock-tree-wrapper { margin-top: 8px; }
		.iwexclock-tree-toolbar { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; padding: 8px 10px; margin-bottom: 6px; border: 1px solid var(--border-color); border-radius: var(--border-radius); background: var(--bg-light-gray); }
		.iwexclock-tree-toolbar-group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
		.iwexclock-tree-toolbar-label { font-size: 12px; font-weight: 600; color: var(--text-color); white-space: nowrap; }
		.iwexclock-tree-toolbar select.form-control { height: 26px; font-size: 12px; padding: 2px 6px; width: auto; display: inline-block; }
		.iwexclock-tree { font-size: 13px; border: 1px solid var(--border-color); border-radius: var(--border-radius); overflow: hidden; }
		.iwexclock-tree-row { display: flex; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--border-color); }
		.iwexclock-tree-node:last-child > .iwexclock-tree-row { border-bottom: none; }
		.iwexclock-tree-row:hover { background: var(--bg-light-gray); }
		.iwexclock-tree-header { font-weight: 600; background: var(--bg-light-gray); }
		.iwexclock-tree-header:hover { background: var(--bg-light-gray); }
		.iwexclock-tree-toggle { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; margin-right: 6px; cursor: pointer; flex-shrink: 0; }
		.iwexclock-tree-toggle-empty { visibility: hidden; cursor: default; }
		.iwexclock-tree-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.iwexclock-tree-meta { display: flex; gap: 18px; color: var(--text-muted); font-variant-numeric: tabular-nums; flex-shrink: 0; }
		.iwexclock-tree-duration { min-width: 80px; text-align: right; white-space: nowrap; }
		.iwexclock-tree-hours { min-width: 70px; text-align: right; white-space: nowrap; }
		.iwexclock-tree-sessions { min-width: 100px; text-align: right; white-space: nowrap; }
		.iwexclock-tree-loading, .iwexclock-tree-empty { padding: 20px; text-align: center; }
		#iwexclock-pivot-table { margin-bottom: 10px; }
		#iwexclock-pivot-chart { margin-bottom: 14px; }
		#iwexclock-pivot-chart .chart-container { padding: 0; }
		.iwexclock-chart-type-select { width: auto; display: inline-block; height: 28px; margin-right: 6px; vertical-align: middle; }
		#iwexclock-pivot-table table.iwexclock-pivot-table { width: 100%; border-collapse: collapse; font-size: 13px; border: 1px solid var(--border-color); border-radius: var(--border-radius); overflow: hidden; }
		#iwexclock-pivot-table th, #iwexclock-pivot-table td { padding: 6px 10px; border-bottom: 1px solid var(--border-color); border-right: 1px solid var(--border-color); text-align: right; white-space: nowrap; }
		#iwexclock-pivot-table th:last-child, #iwexclock-pivot-table td:last-child { border-right: none; }
		#iwexclock-pivot-table tbody tr:last-child th, #iwexclock-pivot-table tbody tr:last-child td { border-bottom: none; }
		#iwexclock-pivot-table thead th { background: var(--bg-light-gray); font-weight: 600; }
		#iwexclock-pivot-table th.iwexclock-pivot-corner, #iwexclock-pivot-table td.iwexclock-pivot-row-label { text-align: left; }
		#iwexclock-pivot-table td.iwexclock-pivot-row-label { font-weight: 500; }
		#iwexclock-pivot-table td.iwexclock-pivot-total-col, #iwexclock-pivot-table th.iwexclock-pivot-total-col { font-weight: 600; background: var(--bg-light-gray); }
		#iwexclock-pivot-table tr.iwexclock-pivot-totals-row { font-weight: 600; background: var(--bg-light-gray); }
	`;
	document.head.appendChild(style);
}
