# -*- coding: utf-8 -*-
# Copyright (c) 2024, iWEX Infomatics and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
import os      # ← ADD THIS
import json 
import requests
import functools

# ═══════════════════════════════════════════════════════════════════════
#                    ENVIRONMENT DETECTION
# ═══════════════════════════════════════════════════════════════════════

def is_erpnext_installed():
    """
    Check if ERPNext is installed (Company DocType exists)
    
    Returns:
        bool: True if ERPNext installed, False otherwise
    """
    return frappe.db.exists("DocType", "Company")


@frappe.whitelist()
def check_company_doctype_exists():
    """
    Whitelisted method for JavaScript to check Company DocType existence
    
    Returns:
        bool: True if Company DocType exists
    """
    return is_erpnext_installed()


def get_company_name_for_registration(settings_doc):
    """
    Get company name for registration with smart fallback
    
    Logic:
    1. If Company DocType exists → Validate and return company_name
    2. If company_name is empty → Use admin_full_name
    3. Otherwise → Return company_name as-is
    
    Args:
        settings_doc: iWEXClock Settings document
        
    Returns:
        str: Company name to use for registration
        
    Raises:
        frappe.ValidationError: If Company required but not provided
    """
    company_name = settings_doc.company_name
    admin_full_name = settings_doc.admin_full_name
    
    # ───────────────────────────────────────────────────────────────────
    # SCENARIO 1: ERPNext installed
    # ───────────────────────────────────────────────────────────────────
    if is_erpnext_installed():
        if not company_name:
            frappe.throw(
                _("Company is required when ERPNext is installed"),
                frappe.ValidationError
            )
        
        # Validate company exists
        if not frappe.db.exists("Company", company_name):
            frappe.throw(
                _("Company '{0}' does not exist").format(company_name),
                frappe.ValidationError
            )
        
        return company_name
    
    # ───────────────────────────────────────────────────────────────────
    # SCENARIO 2: Plain Frappe - company_name empty
    # ───────────────────────────────────────────────────────────────────
    if not company_name or company_name.strip() == "":
        if not admin_full_name:
            frappe.throw(
                _("Either Company Name or Admin Full Name is required"),
                frappe.ValidationError
            )
        
        frappe.logger().info(
            f"📦 Using Admin Full Name as company: {admin_full_name}"
        )
        return admin_full_name
    
    # ───────────────────────────────────────────────────────────────────
    # SCENARIO 3: Plain Frappe - company_name provided
    # ───────────────────────────────────────────────────────────────────
    return company_name


def get_company_details_safe(company_name):
    """
    Safely fetch company details if Company DocType exists
    
    Args:
        company_name: Company name to fetch
        
    Returns:
        dict: Company details or empty dict if not available
    """
    if not is_erpnext_installed():
        # Plain Frappe - no Company DocType
        return {}
    
    if not frappe.db.exists("Company", company_name):
        return {}
    
    try:
        company_doc = frappe.get_doc("Company", company_name)
        
        details = {
            "gstin": getattr(company_doc, "gstin", None),
            "tax_id": getattr(company_doc, "tax_id", None),
            "default_currency": getattr(company_doc, "default_currency", None),
            "country": getattr(company_doc, "country", None),
            "email": getattr(company_doc, "email", None),
            "phone_no": getattr(company_doc, "phone_no", None),
            "website": getattr(company_doc, "website", None)
        }
        
        return details
        
    except Exception as e:
        frappe.logger().error(f"Error fetching company details: {str(e)}")
        return {}
class iWEXClockSettings(Document):
    def validate(self):
        """
        Validate document before saving
        
        ✅ ADDED: Smart company name validation
        """
        # ───────────────────────────────────────────────────────────────
        # Validate company name based on environment
        # ───────────────────────────────────────────────────────────────
        if is_erpnext_installed():
            # ERPNext: Company required and must exist
            if not self.company_name:
                frappe.throw(
                    _("Company is required when ERPNext is installed"),
                    frappe.ValidationError
                )
            
            if not frappe.db.exists("Company", self.company_name):
                frappe.throw(
                    _("Company '{0}' does not exist").format(self.company_name),
                    frappe.ValidationError
                )
        else:
            # Plain Frappe: Company optional, but need either company or admin name
            if not self.company_name and not self.admin_full_name:
                frappe.throw(
                    _("Either Company Name or Admin Full Name must be provided"),
                    frappe.ValidationError
                )
    def on_update(self):
        """
        Called after document is saved
        Cleanup welcome items when registration completes
        """
        # Check if registration status is now "Registered"
        if self.registration_status == "Registered":
            # Check if this was just changed (not already registered before)
            if self.has_value_changed("registration_status"):
                # Trigger cleanup in background
                frappe.enqueue(
                    'iwexclock.install.cleanup_after_registration',
                    queue='short',
                    timeout=300
                )
                
                frappe.logger().info("🎉 Registration complete - cleanup enqueued")

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
        
        # Handle User
        user, user_created = handle_user_creation(bot_email, bot_full_name, messages)
        
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
                "api_key": api_key,        # ← Real API key (not masked)
                "api_secret": api_secret,  # ← Real API secret
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




def handle_user_creation(email, full_name, messages):
    """
    Create or update bot user as System Manager.
    """
    if not frappe.db.exists("User", email):
        user = frappe.get_doc({
            "doctype": "User",
            "email": email,
            "first_name": full_name,
            "enabled": 1,
            "user_type": "System User",
            "send_welcome_email": 0,
            "roles": [
                {"role": "System Manager"},
                {"role": "All"}
            ]
        }).insert(ignore_permissions=True)

        messages.append({
            "type": "success",
            "message": f"✅ System Manager bot user created: {email}"
        })
        return user, True

    # User exists
    user = frappe.get_doc("User", email)

    user_roles = {d.role for d in user.roles}
    updated = False

    if "System Manager" not in user_roles:
        user.append("roles", {"role": "System Manager"})
        updated = True

    if "All" not in user_roles:
        user.append("roles", {"role": "All"})
        updated = True

    if updated:
        user.save(ignore_permissions=True)
        messages.append({
            "type": "success",
            "message": "✅ System Manager role ensured for bot user"
        })
    else:
        messages.append({
            "type": "info",
            "message": "ℹ️ Bot user already has System Manager role"
        })

    return user, False


def handle_api_credentials_smart(user, messages):
    """
    Generate API credentials and ALWAYS read them
    from User -> API Access (source of truth)
    """
    from frappe.core.doctype.user.user import generate_keys

    # Generate / regenerate keys
    generate_keys(user.name)

    # Reload user to get persisted values
    user.reload()

    api_key = user.api_key
    api_secret = user.get_password("api_secret")

    messages.append({
        "type": "success",
        "message": _("✅ API key & secret generated and fetched from API Access")
    })

    return api_key, api_secret


def sync_settings_with_api_keys(bot_email, api_key, api_secret, messages):
    settings = frappe.get_single("iWEXClock Settings")

    settings.bot_user = bot_email
    settings.bot_api_key = api_key
    settings.bot_api_secret = api_secret

    settings.save(ignore_permissions=True)

    messages.append({
        "type": "success",
        "message": "API credentials synced to iWEXClock Settings"
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

        generate_keys(user.name)

        user.reload()

        api_key = user.api_key
        api_secret = user.get_password("api_secret")

        
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
    
    # ═══════════════════════════════════════════════════════════════════════
#                    REGISTRATION PROXY METHOD
# ═══════════════════════════════════════════════════════════════════════

@frappe.whitelist()
def register_with_iwex(
    admin_user_id,
    admin_full_name,
    admin_email_id,
    primary_contact_number,
    domain_name,
    company_name=None
):
    """
    Proxy method to call iWEXClock registration API
    
    ✅ UPDATED: Now handles both ERPNext and plain Frappe sites
    """
    
    frappe.logger().info("=" * 70)
    frappe.logger().info("🚀 REGISTRATION PROXY CALLED")
    frappe.logger().info("=" * 70)
    
    # ═══════════════════════════════════════════════════════════════════
    # STEP 1: Determine actual company name to use
    # ═══════════════════════════════════════════════════════════════════
    settings = frappe.get_single("iWEXClock Settings")
    
    # Get company name with smart fallback
    actual_company_name = get_company_name_for_registration(settings)
    
    frappe.logger().info(f"📦 Environment: {'ERPNext' if is_erpnext_installed() else 'Plain Frappe'}")
    frappe.logger().info(f"🏢 Company Name (input): {company_name}")
    frappe.logger().info(f"🏢 Company Name (actual): {actual_company_name}")
    frappe.logger().info(f"👤 Admin Name: {admin_full_name}")
    
    # ═══════════════════════════════════════════════════════════════════
    # STEP 2: Get company details (if ERPNext)
    # ═══════════════════════════════════════════════════════════════════
    company_details = get_company_details_safe(actual_company_name)
    
    import requests
    import json
    
    try:
        # ═══════════════════════════════════════════════════════════════
        # STEP 3: Prepare payload with smart defaults
        # ═══════════════════════════════════════════════════════════════
        api_base_url = get_iwexclock_api_url()
        frappe.logger().info(f"📍 API Base URL: {api_base_url}")
        
        payload = {
            'admin_name': admin_full_name,
            'admin_email': admin_email_id,
            'admin_mobile': primary_contact_number,
            'company_name': actual_company_name,  # ← Use smart company name
            'domain': domain_name,
            
            # Company details (if available from ERPNext)
            "gstin": company_details.get("gstin"),
            "tax_id": company_details.get("tax_id"),
            "default_currency": company_details.get("default_currency"),
            "country": company_details.get("country"),
            "company_email": company_details.get("email"),
            "company_phone": company_details.get("phone_no"),
            "website": company_details.get("website")
        }
        
        # Log sanitized payload (without sensitive data)
        frappe.logger().info(f"📦 Payload prepared:")
        frappe.logger().info(json.dumps({
            **payload,
            'admin_mobile': '****' + payload['admin_mobile'][-4:] if payload['admin_mobile'] else None
        }, indent=2))
        
        # ═══════════════════════════════════════════════════════════════
        # STEP 4: Make HTTP request
        # ═══════════════════════════════════════════════════════════════
        full_api_url = f"{api_base_url}/api/method/iwexclock_parent.api.registration.initiate_registration"
        frappe.logger().info(f"🌐 Full URL: {full_api_url}")
        
        response = requests.post(
            url=full_api_url,
            json=payload,
            headers={'Accept': 'application/json'},
            timeout=30
        )
        
        # ... rest of your existing response handling code ...
        
        frappe.logger().info(f"📥 Response received:")
        frappe.logger().info(f"   Status Code: {response.status_code}")
        
        # Validate response (your existing code)
        if not response.text or response.text.strip() == "":
            frappe.logger().error("❌ Empty response body")
            return {
                "status": "error",
                "message": "Server returned empty response"
            }
        
        if response.status_code != 200:
            frappe.logger().error(f"❌ HTTP Error {response.status_code}")
            return {
                "status": "error",
                "message": f"HTTP {response.status_code}: {response.text[:200]}"
            }
        
        # Parse JSON
        try:
            result = response.json()
            
            # Unwrap Frappe's 'message' wrapper
            if 'message' in result:
                result = result['message']
            
            frappe.logger().info("=" * 70)
            frappe.logger().info("✅ REGISTRATION COMPLETED")
            frappe.logger().info("=" * 70)
            
            return result
            
        except json.JSONDecodeError as json_err:
            frappe.logger().error(f"❌ JSON Parse Error: {str(json_err)}")
            return {
                "status": "error",
                "message": f"Invalid JSON from server: {str(json_err)}"
            }
    
    except requests.exceptions.ConnectionError as conn_err:
        frappe.logger().error("❌ CONNECTION ERROR")
        return {
            "status": "error",
            "message": f"Cannot connect to central server at {api_base_url}"
        }
    
    except Exception as e:
        frappe.logger().error("❌ UNEXPECTED ERROR")
        frappe.logger().error(frappe.get_traceback())
        return {
            "status": "error",
            "message": f"Unexpected error: {str(e)}"
        }




GITHUB_CONFIG_URL = "https://raw.githubusercontent.com/iWEXDev/iWEX/main/erp_file.json.enc"
CACHE_KEY = "iwexclock_central_url"
CACHE_DURATION_HOURS = 24  # Configurable based on your needs


def get_iwexclock_api_url():
    """
    PRODUCTION-READY: Get iWEXClock API URL with intelligent caching
    
    Priority:
    1. Cache (fastest, most reliable)
    2. GitHub (if cache expired/missing)
    3. site_config.json (if GitHub fails)
    4. Hardcoded default (emergency fallback)
    """
    
    # TIER 1: Check cache first (1-2ms response)
    try:
        cached_url = frappe.cache().get_value(CACHE_KEY)
        if cached_url:
            return cached_url.rstrip('/')
    except Exception as e:
        frappe.logger().error(f"Cache read error: {e}")
    
    # TIER 2: Fetch from GitHub (200-500ms response)
    try:
        github_url = fetch_and_cache_from_github()
        if github_url:
            return github_url.rstrip('/')
    except Exception as e:
        frappe.logger().error(f"GitHub fetch error: {e}")
    
    # TIER 4: Emergency default
    default_url = "https://www.iwex.in"
    frappe.logger().warning(f"Using emergency default: {default_url}")
    return default_url


def fetch_and_cache_from_github():
    """
    Fetch from GitHub with timeout and retry logic
    
    Returns:
        str|None: URL from GitHub or None if failed
    """
    try:
        response = requests.get(
            GITHUB_CONFIG_URL,
            timeout=5,  # Fail fast - don't block users
            headers={'Accept': 'application/json'}
        )
        
        if response.status_code != 200:
            return None
        
        config = response.json()
        central_url = config.get('central_site_url')
        
        if not central_url:
            return None
        
        # Cache for 24 hours
        frappe.cache().set_value(
            CACHE_KEY,
            central_url,
            expires_in_sec=CACHE_DURATION_HOURS * 3600
        )
        
        frappe.logger().info(f"✅ GitHub config cached: {central_url}")
        return central_url
        
    except requests.Timeout:
        frappe.logger().error("GitHub request timed out (5s)")
        return None
    except Exception as e:
        frappe.logger().error(f"GitHub fetch failed: {e}")
        return None