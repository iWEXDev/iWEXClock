console.log("✅ iWEXClock welcome JS loaded");

$(document).on("app_ready", function () {
    console.log("🚀 app_ready fired");

    frappe.call({
        method: "iwexclock.api.should_show_welcome",
        callback: function (r) {
            if (!r.message) return;

            const d = new frappe.ui.Dialog({
                title: "Welcome to iWEXClock",
                primary_action_label: "Get Started",
                primary_action() {
                    d.hide();
                    frappe.set_route("Form", "iWEXClock Settings");
                },
                secondary_action_label: "Close",
                secondary_action() {
                    d.hide();
                }
            });

            d.set_message(
                "<p>Welcome! Please complete the initial setup to start using iWEXClock.</p>"
            );

            d.show();

            // Mark as shown immediately
            frappe.call({
                method: "iwexclock.api.mark_welcome_shown"
            });
        }
    });
});
