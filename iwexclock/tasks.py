import frappe

def schedule_next_checked_day(start_date_obj, doc, starts_from_time, day_field_map):
    if not start_date_obj or not doc:
        return

    for i in range(1, 8):
        next_date = frappe.utils.add_to_date(start_date_obj, days=i)
        if not next_date:
            continue

        next_checkbox = day_field_map.get(next_date.weekday())

        if next_checkbox and doc.get(next_checkbox):
            future_alert = f"{frappe.utils.formatdate(next_date, 'yyyy-mm-dd')} {starts_from_time}"

            if doc.expire_on:
                expire_dt = frappe.utils.get_datetime(f"{doc.expire_on} 23:59:59")
                if frappe.utils.get_datetime(future_alert) > expire_dt:
                    doc.next_alert_on = None
                    doc.enabled = 0
                else:
                    doc.next_alert_on = future_alert
            else:
                doc.next_alert_on = future_alert
            return

    doc.next_alert_on = None


def process_reminders():
    try:
        now = frappe.utils.now_datetime()

        docs = frappe.get_all(
            "iWEXClock Reminder",
            filters={"next_alert_on": ("<=", now), "enabled": 1},
            fields=[
                "name", "next_alert_on", "previous_alert_was", "frequency", "start_date",
                "from_time", "to_time", "start_time", "mon", "tue", "wed", "thu", "fri",
                "sat", "sun", "duration", "every", "expire_on"
            ],
            order_by="next_alert_on asc"   # 🔥 FIX 1 (important)
        )

        for d in docs:
            try:
                d = frappe._dict(d)   # 🔥 FIX 2 (VERY IMPORTANT)

                if not d.next_alert_on:
                    continue

                frappe.db.set_value("iWEXClock Reminder",
                   d.name, "previous_alert_was", d.next_alert_on)

                expire_dt = frappe.utils.get_datetime(f"{d.expire_on} 23:59:59") if d.expire_on else None

                # ------------------ SIMPLE FREQUENCY ------------------

                if d.frequency == "Once":
                    frappe.db.set_value("iWEXClock Reminder", d.name, {
                        "next_alert_on": None,
                        "enabled": 0
                    })

                elif d.frequency in ["Daily", "Weekly", "Monthly", "Annually"]:
                    new_next = frappe.utils.get_datetime(d.next_alert_on)

                    while new_next <= now:
                        if d.frequency == "Daily":
                            new_next = frappe.utils.add_days(new_next, 1)
                        elif d.frequency == "Weekly":
                            new_next = frappe.utils.add_days(new_next, 7)
                        elif d.frequency == "Monthly":
                            new_next = frappe.utils.add_months(new_next, 1)
                        elif d.frequency == "Annually":
                            new_next = frappe.utils.add_years(new_next, 1)

                        if expire_dt and new_next > expire_dt:
                            new_next = None
                            frappe.db.set_value("iWEXClock Reminder", d.name, "enabled", 0)
                            break

                    frappe.db.set_value("iWEXClock Reminder", d.name, "next_alert_on", new_next)

                # ------------------ CUSTOM ------------------

                elif d.frequency == "Custom":
                    start_date_obj = frappe.utils.get_datetime(d.start_date) if d.start_date else None

                    if not start_date_obj:
                        frappe.db.set_value("iWEXClock Reminder", d.name, "next_alert_on", None)
                        continue

                    today = frappe.utils.get_datetime(frappe.utils.today())
                    current_date = today if start_date_obj.date() < today.date() else start_date_obj

                    day_map = {0: "mon", 1: "tue", 2: "wed", 3: "thu", 4: "fri", 5: "sat", 6: "sun"}
                    checkbox = day_map.get(current_date.weekday())

                    start_time = str(d.from_time or "00:00:00")
                    end_time = str(d.to_time or "23:59:59")

                    if checkbox and d.get(checkbox):

                        interval = 60
                        if d.duration and d.every:
                            factor = {"Seconds": 1, "Minutes": 60, "Hours": 3600}
                            interval = int(d.every) * factor.get(d.duration, 60)

                        current_time = frappe.utils.get_time(start_time)
                        end_time_obj = frappe.utils.get_time(end_time)

                        next_alert = None

                        while current_time <= end_time_obj:
                            alert_dt = frappe.utils.get_datetime(
                                f"{frappe.utils.formatdate(current_date, 'yyyy-mm-dd')} {current_time}"
                            )

                            # 🔥 FIX 3 → USE >= not >
                            if alert_dt >= now and (not expire_dt or alert_dt <= expire_dt):
                                next_alert = alert_dt
                                break

                            total = current_time.hour * 3600 + current_time.minute * 60 + current_time.second + interval
                            current_time = frappe.utils.get_time(
                                "%02d:%02d:%02d" % ((total // 3600) % 24, (total % 3600) // 60, total % 60)
                            )

                        if next_alert:
                            frappe.db.set_value("iWEXClock Reminder", d.name, "next_alert_on", next_alert)
                        else:
                            doc = frappe.get_doc("iWEXClock Reminder", d.name)
                            schedule_next_checked_day(current_date, doc, start_time, day_map)

                            frappe.db.set_value("iWEXClock Reminder", d.name, {
                                "next_alert_on": doc.next_alert_on,
                                "enabled": doc.enabled
                            })

                    else:
                        doc = frappe.get_doc("iWEXClock Reminder", d.name)
                        schedule_next_checked_day(current_date, doc, start_time, day_map)

                        frappe.db.set_value("iWEXClock Reminder", d.name, {
                            "next_alert_on": doc.next_alert_on,
                            "enabled": doc.enabled
                        })

            except Exception:
                frappe.log_error(frappe.get_traceback(), f"Reminder Failed: {d.name}")

        frappe.db.commit()

    except Exception:
        frappe.log_error(frappe.get_traceback(), "Scheduler Crash")