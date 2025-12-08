import frappe
from frappe import _

@frappe.whitelist(allow_guest=False)
def register_user(user_name, company_name, approved=0):
    """
    Register a new IWEXClock user
    
    Args:
        user_name (str): Name of the user
        company_name (str): Name of the company
        approved (int): Approval status (0 or 1)
    
    Returns:
        dict: Success status and message
    """
    try:
        # Validate inputs
        if not user_name or not company_name:
            return {
                "success": False,
                "message": _("User Name and Company Name are required")
            }
        
        # Convert approved to integer
        approved = int(approved) if approved else 0
        
        # Check if user is already registered (optional - prevent duplicates)
        existing = frappe.db.exists(
            "iWEXClock User Register",
            {"user_name": user_name}
        )
        
        if existing:
            return {
                "success": False,
                "message": _("This user is already registered")
            }
        
        # Create new registration record
        doc = frappe.get_doc({
            "doctype": "iWEXClock User Register",
            "user_name": user_name,
            "company_name": company_name,
            "approved": approved
        })
        
        # Insert and save
        doc.insert(ignore_permissions=True)
        frappe.db.commit()
        
        frappe.msgprint(
            _("Registration completed successfully"),
            title=_("Success"),
            indicator="green"
        )
        
        return {
            "success": True,
            "message": _("Registration successful"),
            "registration_id": doc.name
        }
        
    except Exception as e:
        frappe.log_error(
            message=frappe.get_traceback(),
            title="IWEXClock Registration Error"
        )
        return {
            "success": False,
            "message": _("Error: {0}").format(str(e))
        }