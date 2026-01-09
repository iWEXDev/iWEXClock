import frappe

# ---------------------------------------------------------------------
# CONSTANTS
# ---------------------------------------------------------------------

ADMIN_USER = "Administrator"

ANNOUNCEMENT_HTML = """
<p>
<b>Welcome to iWEXClock 👋</b><br>
Please complete the initial setup to start using iWEXClock.
</p>

<p>
<a href="/app/Form/iWEXClock Settings">
👉 Open iWEXClock Settings
</a>
</p>
"""

NOTE_TITLE = "About iWEXClock"
NOTIFICATION_SUBJECT = "Welcome to iWEXClock"


# ---------------------------------------------------------------------
# HOOK ENTRY POINTS
# ---------------------------------------------------------------------

def after_install():
    """
    Called automatically after app installation
    """
    setup_navbar_help()
    create_navbar_announcement()
    create_note()
    create_notification_log()
    


def before_uninstall():
    """
    Called automatically before app uninstall
    """
    delete_navbar_announcement()
    delete_notification_log()
    delete_note()
    remove_navbar_help()


# ---------------------------------------------------------------------
# NAVBAR ANNOUNCEMENT
# (Navbar Settings → Announcements → Announcement Widget)
# ---------------------------------------------------------------------

def create_navbar_announcement():
    navbar = frappe.get_single("Navbar Settings")

    # Avoid overwriting if already set
    if navbar.announcement_widget and ANNOUNCEMENT_HTML.strip() in navbar.announcement_widget:
        return

    navbar.announcement_widget = ANNOUNCEMENT_HTML
    navbar.save(ignore_permissions=True)
    
    frappe.db.commit()


def delete_navbar_announcement():
    navbar = frappe.get_single("Navbar Settings")

    if navbar.announcement_widget:
        navbar.announcement_widget = ""
        navbar.save(ignore_permissions=True)
        frappe.db.commit()


def create_note():
    if frappe.db.exists(
        "Note",
        {"title": NOTE_TITLE, "owner": ADMIN_USER}
    ):
        return

    frappe.get_doc({
        "doctype": "Note",
        "title": NOTE_TITLE,
        "content": """
<h3>About iWEXClock</h3>

<p>
iWEXClock is an employee time tracking and productivity
monitoring solution integrated with ERPNext.
</p>

<ul>
  <li>Activity tracking</li>
  <li>Project-based time logs</li>
  <li>Secure background sync</li>
</ul>

<p>
<a href="/app/Form/iWEXClock Settings">
Open iWEXClock Settings
</a>
</p>
        """,
        "owner": ADMIN_USER,
        "public": 0,
        "notify_on_login": 1
    }).insert(ignore_permissions=True)

    frappe.db.commit()


def delete_note():
    notes = frappe.get_all(
        "Note",
        filters={
            "title": NOTE_TITLE,
            "owner": ADMIN_USER
        },
        pluck="name"
    )

    for note in notes:
        frappe.delete_doc("Note", note, ignore_permissions=True)

    frappe.db.commit()


# ---------------------------------------------------------------------
# NOTIFICATION LOG (FALLBACK VISIBILITY)
# ---------------------------------------------------------------------

def create_notification_log():
    # Avoid duplicate notifications
    if frappe.db.exists(
        "Notification Log",
        {
            "subject": NOTIFICATION_SUBJECT,
            "for_user": ADMIN_USER
        }
    ):
        return

    note_name = frappe.db.get_value(
        "Note",
        {"title": NOTE_TITLE, "owner": ADMIN_USER},
        "name"
    )

    frappe.get_doc({
        "doctype": "Notification Log",
        "subject": NOTIFICATION_SUBJECT,
        "email_content": """
Welcome to <b>iWEXClock</b> 🎉<br><br>

Click this notification to read about the app
and open the settings page.
        """,
        "for_user": ADMIN_USER,
        "type": "Alert",
        "document_type": "Note",
        "document_name": note_name
    }).insert(ignore_permissions=True)

    frappe.db.commit()


def delete_notification_log():
    logs = frappe.get_all(
        "Notification Log",
        filters={
            "subject": NOTIFICATION_SUBJECT,
            "for_user": ADMIN_USER
        },
        pluck="name"
    )

    for log in logs:
        frappe.delete_doc("Notification Log", log, ignore_permissions=True)

    frappe.db.commit()
def setup_navbar_help():
    """
    Add iWEXClock entry to Help dropdown via Navbar Settings
    """
    # Navbar Settings is a Single DocType
    navbar = frappe.get_single("Navbar Settings")

    # Avoid duplicates
    for row in navbar.help_dropdown:
        if row.item_label == "iWEXClock":
            return

    # Add new Help dropdown item
    navbar.append("help_dropdown", {
        "item_label": "iWEXClock",
        "item_type": "Route",
        # Route to Settings (Single DocType)
        "route": "Form/iWEXClock Settings"
    })

    navbar.save(ignore_permissions=True)
    frappe.db.commit()
def remove_navbar_help():
    """
    Remove iWEXClock entry from Help dropdown when uninstalling
    """
    try:
        navbar = frappe.get_single("Navbar Settings")
        
        # Find and remove the item
        items_to_remove = []
        for idx, row in enumerate(navbar.help_dropdown):
            if row.item_label == "iWEXClock":
                items_to_remove.append(idx)
        
        # Remove in reverse order to maintain indices
        for idx in reversed(items_to_remove):
            navbar.remove(navbar.help_dropdown[idx])
        
        if items_to_remove:
            navbar.save(ignore_permissions=True)
            frappe.db.commit()
            print("✅ iWEXClock removed from Help dropdown")
    except Exception as e:
        print(f"⚠️ Error removing from Help dropdown: {e}")

def cleanup_after_registration():
    """
    Remove welcome items after successful registration
    
    Called automatically when registration_status changes to "Registered"
    Deletes:
    1. Navbar announcement
    2. Note (About iWEXClock)
    3. Notification Log (Welcome to iWEXClock)
    """
    try:
        frappe.logger().info("🧹 Starting cleanup after registration...")
        
        # Use existing deletion functions
        delete_navbar_announcement()
        frappe.logger().info("✅ Navbar announcement removed")
        
        delete_note()
        frappe.logger().info("✅ Note deleted")
        
        delete_notification_log()
        frappe.logger().info("✅ Notification log deleted")
        
        frappe.db.commit()
        frappe.logger().info("🎉 Cleanup completed successfully")
        
    except Exception as e:
        frappe.logger().error(f"❌ Error in cleanup: {e}")
        frappe.log_error(
            message=frappe.get_traceback(),
            title="iWEXClock Cleanup Error"
        )