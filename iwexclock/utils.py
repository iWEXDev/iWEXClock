# -*- coding: utf-8 -*-
from __future__ import unicode_literals
import frappe
from cryptography.fernet import Fernet, InvalidToken
import base64
import json
import requests


def decrypt_iwexclock_fields(doc, method=None):
    

    fields_to_decrypt = [
        'urlfile_name',
        'keyboard_hits',
        'mouse_hits',
        'app_name',
        'language'
    ]

    frappe.logger().info(f"=== DECRYPT HOOK CALLED === Method: {method}, Doc: {doc.name}")

    # Get encryption key from site_config.json
    encryption_key = frappe.conf.get('enc_key')

    if not encryption_key:
        frappe.log_error("Encryption key missing in site_config.json", "IWEXClock Decryption Error")
        frappe.logger().error("encryption_key not found in site_config.json")
        return

    frappe.logger().info(f"encryption_key loaded: {encryption_key[:15]}...")

    # Prepare Fernet cipher
    if isinstance(encryption_key, str):
        encryption_key = encryption_key.encode('utf-8')

    try:
        cipher = Fernet(encryption_key)
    except Exception as e:
        frappe.log_error(f"Invalid encryption key: {str(e)}", "IWEXClock Decryption Error")
        frappe.logger().error(f"Invalid encryption key: {e}")
        return

    # Loop through each field and attempt decryption
    for field in fields_to_decrypt:
        try:
            value = doc.get(field)

            frappe.logger().info(f"Processing field '{field}', value: {str(value)[:60]}")

            if not value:
                continue

            # Only decrypt fernet encrypted values
            if isinstance(value, str) and value.startswith("gAAAA"):
                try:
                    decrypted = cipher.decrypt(value.encode('utf-8')).decode('utf-8')
                    doc.set(field, decrypted)

                    frappe.logger().info(f"✓ Decrypted '{field}' → {decrypted[:60]}")

                except InvalidToken:
                    frappe.logger().warning(f"InvalidToken: '{field}' is not valid Fernet data.")
                    continue

                except Exception as e:
                    frappe.logger().error(f"Error decrypting '{field}': {e}")
                    frappe.log_error(
                        f"Failed to decrypt field '{field}'\nValue: {value}\nError: {str(e)}",
                        "IWEXClock Decryption Error"
                    )
            else:
                frappe.logger().info(f"Skipping '{field}', does not look encrypted.")
                
        except Exception as field_error:
            frappe.logger().error(f"Unexpected error in field '{field}': {field_error}")
            frappe.log_error(
                f"Unexpected decryption error on field '{field}': {field_error}",
                "IWEXClock Decryption Error"
            )
            continue


def set_reminder_id(doc, method=None):
    if not doc.reminder_id:
        date_str = frappe.utils.nowdate()
        date_parts = date_str.split("-")
        short_date = f"{date_parts[0][2:]}{date_parts[1]}{date_parts[2]}"

        base_id = f"{doc.title} - {short_date}"

        count = frappe.db.count(
            "iWEXClock Reminder",
            filters={"reminder_id": ["like", base_id + "%"]}
        )

        next_number = str(count + 1).zfill(2)
        doc.reminder_id = f"{base_id}{next_number}"

def schedule_next_checked_day(start_date_obj, doc, starts_from_time, day_field_map):
    if not start_date_obj or not doc or not starts_from_time or not day_field_map:
        return

    found = False
    for i in range(1, 8):
        try:
            next_date = frappe.utils.add_to_date(start_date_obj, days=i)
            if not next_date:
                continue

            next_day_index = next_date.weekday()
            next_checkbox = day_field_map.get(next_day_index)

            if next_checkbox and doc.get(next_checkbox):
                next_date_str = frappe.utils.formatdate(next_date, "yyyy-mm-dd")
                if next_date_str:
                    future_alert_str = next_date_str + " " + starts_from_time

                    if doc.expire_on:
                        expire_datetime = frappe.utils.get_datetime(str(doc.expire_on) + " 23:59:59")
                        if frappe.utils.get_datetime(future_alert_str) > expire_datetime:
                            doc.next_alert_on = None
                            doc.enabled = 0
                        else:
                            doc.next_alert_on = future_alert_str
                    else:
                        doc.next_alert_on = future_alert_str

                    found = True
                    break
        except Exception:
            continue

    if not found:
        doc.next_alert_on = None


def set_next_alert(doc, method=None):
    should_process = True

    if not doc.enabled:
        doc.next_alert_on = None
        should_process = False
    elif not doc.start_date or not doc.start_time or not doc.frequency:
        doc.next_alert_on = None
        should_process = False

    if should_process:
        try:
            start_time = doc.start_time if doc.start_time and len(str(doc.start_time).split(':')) == 3 else str(doc.start_time) + ":00"
            alert_datetime_str = str(doc.start_date) + " " + start_time
            alert_datetime = frappe.utils.get_datetime(alert_datetime_str)
            now = frappe.utils.now_datetime()

            if not alert_datetime or not now:
                doc.next_alert_on = None
                should_process = False
        except Exception:
            doc.next_alert_on = None
            should_process = False

    if should_process:
        if doc.expire_on:
            expire_datetime = frappe.utils.get_datetime(str(doc.expire_on) + " 23:59:59")
            if alert_datetime > expire_datetime:
                doc.next_alert_on = None
                doc.enabled = 0
                should_process = False

    if should_process:
        if doc.frequency == "Once":
            if alert_datetime > now:
                doc.next_alert_on = alert_datetime_str
            else:
                doc.next_alert_on = None
                doc.enabled = 0

        elif doc.frequency == "Daily":
            next_day = alert_datetime
            while next_day <= now:
                next_day = frappe.utils.add_to_date(next_day, days=1)
                if doc.expire_on and next_day > expire_datetime:
                    next_day = None
                    doc.enabled = 0
                    break
            doc.next_alert_on = frappe.utils.get_datetime_str(next_day) if next_day else None

        elif doc.frequency == "Weekly":
            next_week = alert_datetime
            while next_week <= now:
                next_week = frappe.utils.add_to_date(next_week, days=7)
                if doc.expire_on and next_week > expire_datetime:
                    next_week = None
                    doc.enabled = 0
                    break
            doc.next_alert_on = frappe.utils.get_datetime_str(next_week) if next_week else None

        elif doc.frequency == "Monthly":
            next_month = alert_datetime
            while next_month <= now:
                next_month = frappe.utils.add_to_date(next_month, months=1)
                if doc.expire_on and next_month > expire_datetime:
                    next_month = None
                    doc.enabled = 0
                    break
            doc.next_alert_on = frappe.utils.get_datetime_str(next_month) if next_month else None

        elif doc.frequency == "Annually":
            next_year = alert_datetime
            while next_year <= now:
                next_year = frappe.utils.add_to_date(next_year, years=1)
                if doc.expire_on and next_year > expire_datetime:
                    next_year = None
                    doc.enabled = 0
                    break
            doc.next_alert_on = frappe.utils.get_datetime_str(next_year) if next_year else None

        elif doc.frequency == "Custom":
            try:
                start_date_obj = frappe.utils.get_datetime(doc.start_date)
                if start_date_obj:
                    today_obj = frappe.utils.get_datetime(frappe.utils.today())
                    current_date_obj = today_obj if start_date_obj.date() < today_obj.date() else start_date_obj

                    day_field_map = {0: "mon", 1: "tue", 2: "wed", 3: "thu", 4: "fri", 5: "sat", 6: "sun"}
                    checkbox_field = day_field_map.get(current_date_obj.weekday())

                    starts_from_time = str(doc.from_time) if doc.from_time else "00:00:00"
                    ends_at_time = str(doc.to_time) if doc.to_time else "23:59:59"

                    if checkbox_field and doc.get(checkbox_field):
                        interval = 60
                        if doc.duration and doc.every:
                            if doc.duration == 'Seconds':
                                interval = int(doc.every)
                            elif doc.duration == 'Minutes':
                                interval = int(doc.every) * 60
                            elif doc.duration == 'Hours':
                                interval = int(doc.every) * 3600

                        alert_times = []
                        current_time = frappe.utils.get_time(starts_from_time)
                        end_time_obj = frappe.utils.get_time(ends_at_time)

                        while current_time and end_time_obj and current_time <= end_time_obj:
                            alert_times.append(current_time)

                            total_seconds = current_time.hour * 3600 + current_time.minute * 60 + current_time.second + interval
                            time_str = "%02d:%02d:%02d" % (
                                (total_seconds // 3600) % 24,
                                (total_seconds % 3600) // 60,
                                total_seconds % 60
                            )
                            current_time = frappe.utils.get_time(time_str)

                        next_alert_time = None

                        for time_obj in alert_times:
                            current_date_str = frappe.utils.formatdate(current_date_obj, "yyyy-mm-dd")
                            alert_datetime = frappe.utils.get_datetime(current_date_str + " " + str(time_obj))
                            if alert_datetime > now:
                                if doc.expire_on and alert_datetime > expire_datetime:
                                    continue
                                next_alert_time = alert_datetime
                                break

                        if next_alert_time:
                            doc.next_alert_on = frappe.utils.get_datetime_str(next_alert_time)
                        else:
                            schedule_next_checked_day(current_date_obj, doc, starts_from_time, day_field_map)
                            if doc.next_alert_on and doc.expire_on and frappe.utils.get_datetime(doc.next_alert_on) > expire_datetime:
                                doc.next_alert_on = None
                                doc.enabled = 0
                    else:
                        schedule_next_checked_day(current_date_obj, doc, starts_from_time, day_field_map)
                        if doc.next_alert_on and doc.expire_on and frappe.utils.get_datetime(doc.next_alert_on) > expire_datetime:
                            doc.next_alert_on = None
                            doc.enabled = 0

            except Exception as e:
                frappe.log_error(f"Error in Custom frequency logic: {str(e)}")
                doc.next_alert_on = None