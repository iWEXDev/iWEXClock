# -*- coding: utf-8 -*-
# Copyright (c) 2024, iWEX Infomatics and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
import os      # ← ADD THIS
import json 

class iWEXClockSettings(Document):
    pass

def check_system_manager_permission():
    """
    Check if current user is System Manager
    Raises PermissionError if not authorized
    """
    if "System Manager" not in frappe.get_roles():
        frappe.throw(
            _("Only System Managers can perform this action"),
            frappe.PermissionError
        )
    
    if not frappe.has_permission("iWEXClock Settings", "write"):
        frappe.throw(
            _("You do not have permission to modify iWEXClock Settings"),
            frappe.PermissionError
        )

@frappe.whitelist()
def create_encryption_key():
    """
    Generate Fernet encryption key
    
    Security:
    - Only System Managers can execute
    - Keys stored in site_config.json (site-specific)
    - Atomic file operations
    - Proper file permissions
    """
    # Check permissions
    check_system_manager_permission()
    
    try:
        from cryptography.fernet import Fernet
        
        messages = []
        
        # Get site-specific config path
        site_config_path = get_site_config_path()
        
        # Check existing key in site_config
        site_config_key = get_key_from_site_config(site_config_path)
        
        if site_config_key:
            # Key already exists
            messages.append({
                "type": "info",
                "message": _("ℹ️ Encryption key already exists in site_config.json")
            })
            
            # Sync to doctype
            settings = frappe.get_single("iWEXClock Settings")
            settings.key = site_config_key
            settings.save(ignore_permissions=True)
            frappe.db.commit()
            
            messages.append({
                "type": "success",
                "message": _("✅ Key synced to doctype field")
            })
            
            final_key = site_config_key
            key_generated = False
            
        else:
            # Generate new key
            new_key = Fernet.generate_key().decode('utf-8')
            
            # Save to site_config (atomic operation)
            save_key_to_site_config(site_config_path, new_key)
            messages.append({
                "type": "success",
                "message": _("✅ Generated new encryption key")
            })
            messages.append({
                "type": "success",
                "message": _("✅ Saved to site_config.json")
            })
            
            # Save to doctype
            settings = frappe.get_single("iWEXClock Settings")
            settings.key = new_key
            settings.save(ignore_permissions=True)
            frappe.db.commit()
            
            messages.append({
                "type": "success",
                "message": _("✅ Key created successfully")
            })
            
            final_key = new_key
            key_generated = True
        
        # Log the action
        frappe.log_error(
            title="Encryption Key Action",
            message=f"Action: {'Generated' if key_generated else 'Synced'}\nUser: {frappe.session.user}\nSite: {frappe.local.site}"
        )
        
        return {
            "success": True,
            "message": _("Encryption key setup completed successfully"),
            "details": messages,
            "data": {
                "key_generated": key_generated,
                "masked_key": mask_key(final_key),
                "key_length": len(final_key)
            }
        }
        
    except Exception as e:
        frappe.log_error(
            title="Encryption Key Creation Failed",
            message=frappe.get_traceback()
        )
        frappe.db.rollback()
        
        return {
            "success": False,
            "message": _("Failed to create encryption key: {0}").format(str(e)),
            "details": []
        }




def get_key_from_doctype(settings):
    """
    Read encryption key from doctype password field with robust error handling
    """
    try:
        key = settings.get_password("key")
        return key if key else None
    except Exception as e:
        error_msg = str(e)
        # "Password not found" is expected when field is empty
        if "Password not found" not in error_msg:
            frappe.log_error(
                title="Error Reading Encryption Key",
                message=f"Could not read key from doctype: {error_msg}"
            )
        return None


def mask_api_key(api_key):
    """Mask API key for security"""
    if not api_key or len(api_key) < 16:
        return "****"
    return f"{api_key[:8]}...{api_key[-4:]}"


def mask_key(key):
    """Mask encryption key for display"""
    if not key or len(key) < 16:
        return "****"
    return f"{key[:8]}...{key[-8:]}"


def get_site_config_path():
    """Get site-specific config path"""
    site_path = frappe.get_site_path()
    return os.path.join(site_path, "site_config.json")


def get_key_from_site_config(site_config_path):
    """Read encryption key from site_config.json"""
    try:
        if os.path.exists(site_config_path):
            with open(site_config_path, 'r') as f:
                site_config = json.load(f)
                return site_config.get("encryption_key")
    except Exception as e:
        frappe.log_error(
            title="Error Reading site_config.json",
            message=f"Path: {site_config_path}\nError: {str(e)}"
        )
    return None


def save_key_to_site_config(site_config_path, key):
    """
    Save encryption key to site_config.json with atomic operation
    """
    try:
        # Check write permissions
        site_dir = os.path.dirname(site_config_path)
        if not os.access(site_dir, os.W_OK):
            frappe.throw(_("Insufficient permissions to write to site configuration"))
        
        # Read existing config
        site_config = {}
        if os.path.exists(site_config_path):
            with open(site_config_path, 'r') as f:
                site_config = json.load(f)
        
        # Update key
        site_config["encryption_key"] = key
        
        # Atomic write (temp file + rename)
        temp_path = site_config_path + ".tmp"
        with open(temp_path, 'w') as f:
            json.dump(site_config, f, indent=4)
        
        # Atomic rename
        os.replace(temp_path, site_config_path)
        
        # Set secure permissions (owner read/write only)
        os.chmod(site_config_path, 0o600)
        
    except Exception as e:
        frappe.log_error(
            title="Failed to Save Encryption Key",
            message=f"Path: {site_config_path}\nError: {str(e)}"
        )
        frappe.throw(_("Failed to save encryption key: {0}").format(str(e)))

@frappe.whitelist()
def create_bot_user():
    """
    Create or update iWEXClock Bot user with API credentials
    """
    # Check permissions
    check_system_manager_permission()
    
    # # Rate limiting - DISABLED FOR NOW
    # cache_key = f"bot_creation_{frappe.session.user}"
    # if frappe.cache().get_value(cache_key):
    #     frappe.throw(_("Please wait before creating bot user again"))
    
    try:
        messages = []
        
        # Configuration
        role_name = "iWEXClock Bot"
        bot_email = "clock@iwex.in"
        bot_full_name = "iWEXClock Bot"
        
        # Handle Role
        handle_role_creation(role_name, messages)
        
        # Assign Permissions
        assign_role_permissions(role_name, messages)
        
        # Handle User
        user, user_created = handle_user_creation(bot_email, bot_full_name, role_name, messages)
        
        # Handle API Credentials
        api_key, api_secret = handle_api_credentials_smart(user, messages)
        
        # Sync Settings
        sync_settings_with_api_keys(bot_email, api_key, api_secret, messages)
        
        # Commit
        frappe.db.commit()
        
        # # Set rate limit - DISABLED
        # frappe.cache().set_value(cache_key, "1", expires_in_sec=3600)
        
        return {
            "success": True,
            "message": _("Bot user setup completed successfully"),
            "details": messages,
            "data": {
                "username": bot_email,
                "api_key": mask_api_key(api_key),
                "role": role_name
            }
        }
        
    except Exception as e:
        frappe.log_error(
            title="iWEXClock Bot Creation Failed",
            message=frappe.get_traceback()
        )
        frappe.db.rollback()
        
        return {
            "success": False,
            "message": _("Failed to create bot user: {0}").format(str(e)),
            "details": []
        }
def handle_role_creation(role_name, messages):
    """
    Create role if it doesn't exist, skip if it does.
    """
    if not frappe.db.exists("Role", role_name):
        role = frappe.get_doc({
            "doctype": "Role",
            "role_name": role_name,
            "desk_access": 1,
            "disabled": 0
        })
        role.insert(ignore_permissions=True)
        
        messages.append({
            "type": "success",
            "message": _("✅ Role created successfully: {0}").format(role_name)
        })
    else:
        messages.append({
            "type": "info",
            "message": _("ℹ️ Role already exists: {0}").format(role_name)
        })


def assign_role_permissions(role_name, messages):
    """
    Assign permissions to role for required doctypes.
    Only creates permissions if they don't exist.
    """
    doctypes_to_grant = [
        "iWEXClock Data",
        "Project",
        "User",
        "Role",
        "iWEXClock Reminder",
        "iWEXClock Reminder Settings"
    ]
    
    permissions_added = 0
    permissions_existed = 0
    doctypes_missing = []
    
    for doctype in doctypes_to_grant:
        # Check if doctype exists
        if not frappe.db.exists("DocType", doctype):
            doctypes_missing.append(doctype)
            continue
        
        # Check if permission already exists
        existing_perm = frappe.db.exists("Custom DocPerm", {
            "parent": doctype,
            "role": role_name
        })
        
        if not existing_perm:
            # Get doctype meta to check if submittable
            meta = frappe.get_meta(doctype)
            
            # Create new permission
            perm_doc = frappe.get_doc({
                "doctype": "Custom DocPerm",
                "parent": doctype,
                "parenttype": "DocType",
                "parentfield": "permissions",
                "role": role_name,
                "permlevel": 0,
                "read": 1,
                "write": 1,
                "create": 1,
                "delete": 1,
                "submit": 1 if meta.is_submittable else 0,
                "cancel": 1 if meta.is_submittable else 0,
                "amend": 1 if meta.is_submittable else 0,
            })
            perm_doc.insert(ignore_permissions=True)
            permissions_added += 1
        else:
            permissions_existed += 1
    
    # Summary messages
    if permissions_added > 0:
        messages.append({
            "type": "success",
            "message": _("✅ Permissions assigned to {0} doctype(s)").format(permissions_added)
        })
    
    if permissions_existed > 0:
        messages.append({
            "type": "info",
            "message": _("ℹ️ Permissions already existed for {0} doctype(s)").format(permissions_existed)
        })
    
    if doctypes_missing:
        messages.append({
            "type": "warning",
            "message": _("⚠️ DocTypes not found (skipped): {0}").format(", ".join(doctypes_missing))
        })
    
    # Clear cache to apply permissions immediately
    frappe.clear_cache(doctype="DocType")


def handle_user_creation(email, full_name, role_name, messages):
    """
    Create user if it doesn't exist, return existing user if it does.
    Returns: (user_doc, user_created: bool)
    """
    if not frappe.db.exists("User", email):
        # User doesn't exist - create new one
        user = frappe.get_doc({
            "doctype": "User",
            "email": email,
            "first_name": full_name,
            "enabled": 1,
            "user_type": "System User",
            "send_welcome_email": 0,
            "roles": [
                {"role": role_name},
                {"role": "All"}
            ]
        })
        user.insert(ignore_permissions=True)
        
        messages.append({
            "type": "success",
            "message": _("✅ User created successfully: {0}").format(email)
        })
        return user, True
        
    else:
        # User exists - load existing user
        user = frappe.get_doc("User", email)
        
        messages.append({
            "type": "info",
            "message": _("ℹ️ User already exists: {0}").format(email)
        })
        
        # Ensure role is assigned
        user_roles = [d.role for d in user.roles]
        if role_name not in user_roles:
            user.append("roles", {"role": role_name})
            user.save(ignore_permissions=True)
            messages.append({
                "type": "success",
                "message": _("✅ Role '{0}' assigned to existing user").format(role_name)
            })
        
        return user, False


def handle_api_credentials_smart(user, messages):
    """
    SMART API KEY HANDLING:
    - If API key & secret already exist in User → use them (DO NOT regenerate)
    - If missing → generate new ones
    - Returns: (api_key, api_secret)
    """
    # Check if user already has API credentials
    existing_api_key = frappe.db.get_value("User", user.name, "api_key")
    existing_api_secret = frappe.db.get_value("User", user.name, "api_secret")
    
    if existing_api_key and existing_api_secret:
        # Keys exist - reuse them
        messages.append({
            "type": "info",
            "message": _("ℹ️ API key & secret already exist - reusing existing credentials")
        })
        return existing_api_key, existing_api_secret
        
    else:
        # Keys missing - generate new ones
        from frappe.core.doctype.user.user import generate_keys
        
        api_key, api_secret = generate_keys(user.name)
        
        messages.append({
            "type": "success",
            "message": _("✅ API key & secret generated (new credentials)")
        })
        return api_key, api_secret


def sync_settings_with_api_keys(username, api_key, api_secret, messages):
    """
    Sync API credentials to iWEXClock Settings.
    Always updates password field to avoid reference issues.
    """
    settings = frappe.get_single("iWEXClock Settings")
    
    # Track what changed
    changes = []
    
    # Check and update username
    if settings.bot_user != username:
        settings.bot_user = username
        changes.append("username")
    
    # Check and update API key
    if settings.bot_api_key != api_key:
        settings.bot_api_key = api_key
        changes.append("API key")
    
    # ALWAYS update API secret (password fields can have broken references)
    # This is safe because we're syncing from the User's actual credentials
    settings.bot_api_secret = api_secret
    changes.append("API secret")
    
    # Save settings
    settings.save(ignore_permissions=True)
    
    messages.append({
        "type": "success",
        "message": _("✅ Settings updated: {0}").format(", ".join(changes))
    })


@frappe.whitelist()
def regenerate_api_keys():
    """
    Regenerate ONLY API Key and Secret for existing bot user
    
    This method:
    - DOES regenerate API Key & Secret
    - Does NOT recreate bot user
    - Does NOT regenerate encryption key
    - Does NOT touch role/permissions
    
    Safe to call multiple times.
    """
    # Check permissions
    check_system_manager_permission()
    
    try:
        messages = []
        
        # Configuration
        bot_email = "clock@iwex.in"
        
        # Verify bot user exists
        if not frappe.db.exists("User", bot_email):
            return {
                "success": False,
                "message": _("Bot user does not exist. Please create bot first."),
                "details": []
            }
        
        # Get existing bot user
        user = frappe.get_doc("User", bot_email)
        
        messages.append({
            "type": "info",
            "message": _("ℹ️ Using existing bot user: {0}").format(bot_email)
        })
        
        # FORCE regenerate API credentials
        from frappe.core.doctype.user.user import generate_keys
        
        api_key, api_secret = generate_keys(user.name)
        
        messages.append({
            "type": "success",
            "message": _("✅ API Key & Secret regenerated")
        })
        
        # Sync to Settings
        settings = frappe.get_single("iWEXClock Settings")
        settings.bot_api_key = api_key
        settings.bot_api_secret = api_secret
        settings.save(ignore_permissions=True)
        
        messages.append({
            "type": "success",
            "message": _("✅ New credentials saved to Settings")
        })
        
        # Commit
        frappe.db.commit()
        
        return {
            "success": True,
            "message": _("API keys regenerated successfully"),
            "details": messages,
            "data": {
                "username": bot_email,
                "api_key": mask_api_key(api_key),
                "action": "regenerate"
            }
        }
        
    except Exception as e:
        frappe.log_error(
            title="API Keys Regeneration Failed",
            message=frappe.get_traceback()
        )
        frappe.db.rollback()
        
        return {
            "success": False,
            "message": _("Failed to regenerate API keys: {0}").format(str(e)),
            "details": []
        }