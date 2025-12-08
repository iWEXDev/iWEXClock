import frappe

def get_context(context):
    """
    Context for registration page
    No special context needed, just ensure user can access
    """
    context.no_cache = 1
    return context