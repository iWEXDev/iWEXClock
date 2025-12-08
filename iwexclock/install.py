import frappe

def after_install():
    """
    Called immediately after app installation
    Redirect administrator to registration page
    """
    frappe.msgprint(
        msg="""
            <div style="text-align: center;">
                <h3>Welcome to IWEXClock!</h3>
                <p>Please complete your registration to get started.</p>
                <a href="/iwexclock-register" class="btn btn-primary btn-sm">
                    Go to Registration
                </a>
            </div>
        """,
        title="Installation Complete",
        indicator="green",
        primary_action={
            'label': 'Register Now',
            'client_action': 'frappe.set_route',
            'args': ['/iwexclock-register']
        }
    )

def redirect_to_registration(login_manager=None):
    """
    Optional: Redirect users to registration on login if not registered
    """
    user = frappe.session.user
    
    # Skip for Administrator and Guest
    if user in ["Administrator", "Guest"]:
        return
    
    # Check if already registered
    is_registered = frappe.db.exists(
        "iWEXClock User Register",
        {"user_name": user}
    )
    
    if not is_registered:
        frappe.local.response["type"] = "redirect"
        frappe.local.response["location"] = "/iwexclock-register"