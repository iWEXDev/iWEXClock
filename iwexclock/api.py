import frappe
from frappe import _

@frappe.whitelist()
def generate_api_keys_for_iwexclock():
    """
    Generate/return API keys for logged-in user
    
    Security:
    - User must be logged in
    - User must exist in iWEXClock Settings -> List of Users
    - Uses SQL query to avoid reading entire settings doc
    
    Returns:
        dict: {"api_key": str, "api_secret": str, "message": str}
    """
    
    # Verify user is logged in
    current_user = frappe.session.user
    
    if current_user == "Guest":
        frappe.throw(_("Authentication required"), frappe.PermissionError)
    
    # Check if user is authorized (direct SQL query)
    authorized_user = frappe.db.get_value(
        "List of Users",
        {
            "parent": "iWEXClock Settings",
            "parenttype": "iWEXClock Settings",
            "user_id": current_user
        },
        "user_id"
    )
    
    if not authorized_user:
        frappe.throw(
            _("User {0} is not authorized to use iWEXClock. Contact your administrator.").format(current_user),
            frappe.PermissionError
        )
    
    # User is authorized - get/generate API keys
    user_doc = frappe.get_doc("User", current_user)
    
    # Return existing keys if they exist
    if user_doc.api_key and user_doc.api_secret:
        api_secret = user_doc.get_password("api_secret")
        
        frappe.logger().info(f"iWEXClock: Returned existing keys for {current_user}")
        
        return {
            "api_key": user_doc.api_key,
            "api_secret": api_secret,
            "message": "Existing API keys returned"
        }
    
    # Generate new keys
    api_key = frappe.generate_hash(length=15)
    api_secret = frappe.generate_hash(length=15)
    
    user_doc.api_key = api_key
    user_doc.api_secret = api_secret
    user_doc.save(ignore_permissions=True)
    frappe.db.commit()
    
    frappe.logger().info(f"iWEXClock: Generated new keys for {current_user}")
    
    return {
        "api_key": api_key,
        "api_secret": api_secret,
        "message": "New API keys generated successfully"
    }