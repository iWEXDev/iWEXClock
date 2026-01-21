frappe.ui.form.on('iWEXClock Settings', {
    setup: function (frm) {
        console.log('🔧 Setup: Detecting environment...');

        frappe.call({
            method: 'iwexclock.iwexclock.doctype.iwexclock_settings.iwexclock_settings.check_company_doctype_exists',
            callback: function (r) {
                let has_company = !!r.message;
                console.log('📦 Company DocType exists:', has_company);

                // ✅ ADDED: store this flag for reuse in other functions/buttons
                frm._has_company_doctype = has_company;

                if (has_company) {
                    // ═════════════════════════════════════════════
                    // SCENARIO 1: ERPNext Site
                    // ═════════════════════════════════════════════
                    setup_company_field_for_erpnext(frm);

                    // ✅ ADDED: Show Multi-Company Section + Companies table
                    frm.toggle_display("section_multi_company", true);
                    frm.toggle_display("companies", true);

                    // ---- Users child table: related_company → Link ----
                    if (frm.fields_dict.users) {
                        const grid = frm.fields_dict.users.grid;

                        grid.update_docfield_property(
                            'related_company',
                            'fieldtype',
                            'Link'
                        );
                        grid.update_docfield_property(
                            'related_company',
                            'options',
                            'Company'
                        );

                        frm.set_query('related_company', 'users', function () {
                            return {
                                filters: {
                                    is_group: 0
                                }
                            };
                        });

                        console.log('✅ Users table: related_company → Link (ERPNext mode)');
                    }

                } else {
                    // ═════════════════════════════════════════════
                    // SCENARIO 2: Plain Frappe Site
                    // ═════════════════════════════════════════════
                    setup_company_field_for_frappe(frm);

                    // ✅ ADDED: Hide Multi-Company Section + Companies table permanently
                    // (so it won't be visible even before clicking any button)
                    frm.toggle_display("section_multi_company", false);
                    frm.toggle_display("companies", false);

                    console.log('✅ Users table: related_company → Data (Frappe mode)');
                }
            }
        });
    },
    // ═══════════════════════════════════════════════════════════════════
    // COMPANY NAME CHANGE - Auto-fetch company details
    // ═══════════════════════════════════════════════════════════════════
    company_name: function(frm) {
        console.log('🏢 Company name changed:', frm.doc.company_name);
        
        // Only proceed if company_name has a value
        if (!frm.doc.company_name || frm.doc.company_name.trim() === '') {
            console.log('⚠️ Company name is empty - skipping auto-fetch');
            return;
        }
        
        // Only fetch if Company DocType exists (ERPNext environment)
        if (!frm._has_company_doctype) {
            console.log('⚠️ Company DocType not available - skipping auto-fetch');
            return;
        }
        
        console.log('📡 Fetching company details from server...');
        
        frappe.call({
            method: 'iwexclock.iwexclock.doctype.iwexclock_settings.iwexclock_settings.fetch_company_details',
            args: {
                company_name: frm.doc.company_name
            },
            callback: function(r) {
                console.log('📥 Company details response:', r.message);
                
                if (r.message && Object.keys(r.message).length > 0) {
                    // Company found - auto-fill fields
                    const details = r.message;
                    
                    let gstin_value = (details.gstin && details.gstin.trim())
                        ? details.gstin.trim()
                        : ((details.tax_id && details.tax_id.trim()) ? details.tax_id.trim() : "");

                    if (gstin_value) {
                        frm.set_value('gstin', gstin_value);
                        console.log('✅ Auto-filled GSTIN / Tax ID:', gstin_value);
                    } else {
                        console.log('⚠️ GSTIN and Tax ID both empty - not setting gstin field');
                    }
                    
                    // Set Default Currency if available
                    if (details.default_currency) {
                        frm.set_value('default_currency', details.default_currency);
                        console.log('✅ Auto-filled Default Currency:', details.default_currency);
                    }
                    
                    // Set Country if available
                    if (details.country) {
                        frm.set_value('country', details.country);
                        console.log('✅ Auto-filled Country:', details.country);
                    }
                    
                    // Show success notification
                    frappe.show_alert({
                        message: __('✅ Company details auto-filled'),
                        indicator: 'green'
                    }, 3);
                    
                } else {
                    // Company not found or no details available
                    console.log('⚠️ No company details found - fields not modified');
                }
            },
            error: function(r) {
                console.error('🔴 Error fetching company details:', r);
                // Silent fail - don't disrupt user experience
            }
        });
    },



    // ───────────────────────────────────────────────────────────────────
    // REFRESH EVENT - Called when form loads or reloads
    // ───────────────────────────────────────────────────────────────────
    refresh: function(frm) {
        console.log('🔄 Form refreshed');
        
        // Update button label and visibility based on current state
        update_register_button_state(frm);
        
        // ═══════════════════════════════════════════════════════════════
        // WELCOME FLOW INTEGRATION - Added for first-time setup
        // ═══════════════════════════════════════════════════════════════
        iwexclock_welcome_integration.on_form_refresh(frm);
    },
    
    // ───────────────────────────────────────────────────────────────────
    // REGISTER BUTTON CLICK HANDLER
    // This handles 3 different scenarios based on registration status
    // ───────────────────────────────────────────────────────────────────
    register_button: function(frm) {
        console.log('🔵 Register button clicked');
        console.log('Current status:', frm.doc.registration_status);
        console.log('iWEXClock ID:', frm.doc.iwexclock_id);
        
        let status = frm.doc.registration_status;
        let has_id = frm.doc.iwexclock_id && frm.doc.iwexclock_id.trim() !== '';
        
        // ───────────────────────────────────────────────────────────────
        // SCENARIO 1: Full Registration (First time or ID missing)
        // ───────────────────────────────────────────────────────────────
        if (status === 'Not Registered' || !has_id) {
            console.log('➡️ Starting full registration flow');
            start_registration_flow(frm);
        }
        
        // ───────────────────────────────────────────────────────────────
        // SCENARIO 2: Create Bot & Keys (Recovery from bot failure)
        // ───────────────────────────────────────────────────────────────
        else if (status === 'Pending Bot Creation') {
            console.log('➡️ Creating bot and keys (recovery)');
            create_bot_and_keys_only(frm);
        }
        
        // ───────────────────────────────────────────────────────────────
        // SCENARIO 3: Regenerate API Keys (Already registered)
        // ───────────────────────────────────────────────────────────────
        else if (status === 'Registered' && has_id) {
            console.log('➡️ Regenerating API keys');
            regenerate_api_keys(frm);
        }
        
        else {
            console.error('❌ Unexpected state:', status, has_id);
            frappe.msgprint({
                title: __('Error'),
                message: __('Unexpected registration state. Please refresh the page.'),
                indicator: 'red'
            });
        }
    },
    
    // ═══════════════════════════════════════════════════════════════════
    // REGISTRATION STATUS CHANGE - Added for welcome flow cleanup
    // ═══════════════════════════════════════════════════════════════════
    registration_status: function(frm) {
        console.log('🔵 Registration status changed:', frm.doc.registration_status);
        
        // If status changed to "Registered", trigger cleanup
        if (frm.doc.registration_status === 'Registered') {
            iwexclock_welcome_integration.on_registration_complete(frm);
        }
    },
    

    fetch_companies: function(frm) {

    frappe.call({
        method: "iwexclock.iwexclock.doctype.iwexclock_settings.iwexclock_settings.fetch_companies_and_users",
        freeze: true,
        freeze_message: __("Fetching companies and users..."),
        callback: function(r) {

            if (!r.message) return;

            const data = r.message;

            // ✅ COMPANIES TABLE
            frm.clear_table("companies");

            (data.companies || []).forEach(c => {
                let row = frm.add_child("companies");

                // ✅ Your child table fieldnames:
                // company, l_employees, billing_address
                row.company = c.company || "";
                row.total_employees = c.total_employees || 0;
                row.billing_address = c.billing_address || "";
            });

            frm.refresh_field("companies");

            // ✅ USERS TABLE
            frm.clear_table("users");

            (data.users || []).forEach(u => {
                let row = frm.add_child("users");

                // ✅ Your child table fieldnames:
                // related_company, user_id, full_name, email_id, mobile_number, is_active
                row.related_company = u.related_company || "";
                row.user_id = u.user_id || "";
                row.full_name = u.full_name || "";
                row.email_id = u.email_id || "";          // ✅ Mandatory
                row.mobile_number = u.mobile_number || "";
                row.is_active = u.is_active ? 1 : 0;
            });

            frm.refresh_field("users");

            frappe.show_alert({
                message: __("✅ Fetched successfully"),
                indicator: "green"
            });
        }
    });
}




});
function setup_company_field_for_erpnext(frm) {
    console.log('🏢 Setting up for ERPNext environment');
    
    // ───────────────────────────────────────────────────────────────────
    // STEP 1: Convert field to Link type
    // ───────────────────────────────────────────────────────────────────
    frm.set_df_property('company_name', 'fieldtype', 'Link');
    frm.set_df_property('company_name', 'options', 'Company');
    
    // ───────────────────────────────────────────────────────────────────
    // STEP 2: Make field mandatory
    // ───────────────────────────────────────────────────────────────────
    frm.set_df_property('company_name', 'reqd', 1);
    
    // ───────────────────────────────────────────────────────────────────
    // STEP 3: Update label and description
    // ───────────────────────────────────────────────────────────────────
    frm.set_df_property('company_name', 'label', 'Company');
    frm.set_df_property('company_name', 'description', 
        'Select company from ERPNext');
    
    // ───────────────────────────────────────────────────────────────────
    // STEP 4: Add query filter (optional - only active companies)
    // ───────────────────────────────────────────────────────────────────
    frm.set_query('company_name', function() {
        return {
            filters: {
                'is_group': 0  // Only leaf companies
            }
        };
    });
    
    // ───────────────────────────────────────────────────────────────────
    // STEP 5: Add helpful placeholder
    // ───────────────────────────────────────────────────────────────────
    if (frm.fields_dict.company_name) {
        frm.fields_dict.company_name.set_new_description(
            '🏢 <strong>ERPNext Detected:</strong> Select a company from your system'
        );
    }
    
    console.log('✅ ERPNext setup complete');
}


// ═══════════════════════════════════════════════════════════════════════
//                    PLAIN FRAPPE ENVIRONMENT SETUP
// ═══════════════════════════════════════════════════════════════════════

/**
 * Configure company_name field for plain Frappe sites
 * - Keep as Data field
 * - Make optional
 * - Add helpful placeholder
 */
function setup_company_field_for_frappe(frm) {
    console.log('📦 Setting up for plain Frappe environment');
    
    // ───────────────────────────────────────────────────────────────────
    // STEP 1: Ensure Data field type (already default)
    // ───────────────────────────────────────────────────────────────────
    frm.set_df_property('company_name', 'fieldtype', 'Data');
    
    // ───────────────────────────────────────────────────────────────────
    // STEP 2: Make field optional
    // ───────────────────────────────────────────────────────────────────
    frm.set_df_property('company_name', 'reqd', 0);
    
    // ───────────────────────────────────────────────────────────────────
    // STEP 3: Update description
    // ───────────────────────────────────────────────────────────────────
    frm.set_df_property('company_name', 'description', 
        'Enter company name (optional - will use Admin Full Name if empty)');
    
    // ───────────────────────────────────────────────────────────────────
    // STEP 4: Add placeholder text
    // ───────────────────────────────────────────────────────────────────
    frm.set_df_property('company_name', 'placeholder', 
        'Enter your company name');
    
    // ───────────────────────────────────────────────────────────────────
    // STEP 5: Add helpful info message
    // ───────────────────────────────────────────────────────────────────
    if (frm.fields_dict.company_name) {
        frm.fields_dict.company_name.set_new_description(
            '📦 <strong>Frappe Site:</strong> Enter company name or leave empty to use Admin Full Name'
        );
    }
    
    console.log('✅ Plain Frappe setup complete');
}

// ═══════════════════════════════════════════════════════════════════════
//                    BUTTON STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Updates register button label and visibility based on current status
 * 
 * Button States:
 * - "Register" → status = "Not Registered" OR iwexclock_id missing
 * - "Create Bot & Keys" → status = "Pending Bot Creation"
 * - "Regenerate Keys" → status = "Registered" AND has iwexclock_id
 */
function update_register_button_state(frm) {
    if (!frm.doc) return;
    
    let status = frm.doc.registration_status;
    let has_id = frm.doc.iwexclock_id && frm.doc.iwexclock_id.trim() !== '';
    
    console.log('🔧 Updating button state:', { status, has_id });
    
    // ───────────────────────────────────────────────────────────────────
    // STATE 1: Show "Regenerate Keys" for fully registered accounts
    // ───────────────────────────────────────────────────────────────────
    if (status === 'Registered' && has_id) {
        console.log('🔑 Button: Regenerate Keys');
        frm.set_df_property('register_button', 'label', __('Regenerate Keys'));
        if (frm.fields_dict.register_button) {
            frm.fields_dict.register_button.$wrapper.show();
        }
        return;
    }
    
    // ───────────────────────────────────────────────────────────────────
    // STATE 2: Show "Create Bot & Keys" for recovery
    // ───────────────────────────────────────────────────────────────────
    if (status === 'Pending Bot Creation' && has_id) {
        console.log('🤖 Button: Create Bot & Keys');
        frm.set_df_property('register_button', 'label', __('Create Bot & Keys'));
        if (frm.fields_dict.register_button) {
            frm.fields_dict.register_button.$wrapper.show();
        }
        return;
    }
    
    // ───────────────────────────────────────────────────────────────────
    // STATE 3: Show "Register" for new or incomplete registrations
    // ───────────────────────────────────────────────────────────────────
    console.log('📝 Button: Register');
    frm.set_df_property('register_button', 'label', __('Register'));
    if (frm.fields_dict.register_button) {
        frm.fields_dict.register_button.$wrapper.show();
    }
}


// ═══════════════════════════════════════════════════════════════════════
//                    REGISTRATION FLOW (SCENARIO 1)
// ═══════════════════════════════════════════════════════════════════════

/**
 * PHASE 1: Start full registration flow
 * Steps: Validate → Confirm → API Call → Bot → Keys → Save
 */
/**
 * Ensure bot user + API credentials exist before registration
 * - Creates bot if missing
 * - Generates keys if missing
 * - Copies values if already present
 */
function ensure_bot_ready(frm) {
    return new Promise((resolve, reject) => {

        const bot_missing =
            !frm.doc.bot_user ||
            !frm.doc.bot_api_key ||
            !frm.doc.bot_api_secret;

        if (!bot_missing) {
            console.log('✅ Bot and credentials already present');
            return resolve();
        }

        console.log('🤖 Bot or credentials missing, ensuring bot setup…');

        frappe.call({
            method: 'iwexclock.iwexclock.doctype.iwexclock_settings.iwexclock_settings.create_bot_user',
            freeze: true,
            freeze_message: __('Ensuring bot user & API keys...'),
            callback: function (r) {
                if (!r.message || !r.message.success) {
                    frappe.msgprint({
                        title: __('Bot Setup Failed'),
                        message: r.message?.message || __('Unable to setup bot'),
                        indicator: 'red'
                    });
                    return reject();
                }

                const data = r.message.data;

                // 🔐 Show credentials ONCE (only if they were missing)
                frappe.msgprint({
                    title: __('🔐 API Credentials'),
                    indicator: 'green',
                    message: `
                        <b>User:</b> ${data.username}<br><br>
                        <b>API Key:</b><br>
                        <code style="word-break:break-all">${data.api_key}</code><br><br>
                        <b>API Secret:</b><br>
                        <code style="word-break:break-all">${data.api_secret}</code><br><br>
                        <small>⚠️ Copy and store securely.</small>
                    `
                });

                // Sync fields locally (backend already saved)
                frm.set_value('bot_user', data.username);
                frm.set_value('bot_api_key', data.api_key);
                frm.set_value('bot_api_secret', data.api_secret);

                frm.reload_doc().then(() => {
                console.log('✅ Bot credentials synced from backend');
                resolve();
            });
            }
        });
    });
}

function start_registration_flow(frm) {
    console.log('🚀 Starting registration flow');
    
    // ───────────────────────────────────────────────────────────────────
    // STEP 1: Validate form data
    // ───────────────────────────────────────────────────────────────────
    let validation = validate_registration_form(frm);
    if (!validation.valid) {
        frappe.msgprint({
            title: __('Validation Error'),
            message: validation.message,
            indicator: 'red'
        });
        return;
    }
    
    // ───────────────────────────────────────────────────────────────────
    // STEP 2: Show confirmation dialog
    // ───────────────────────────────────────────────────────────────────
    frappe.confirm(
        __('Register with iWEXClock?<br><br>This will:<br>' +
           '• Create your account on iwex.in<br>' +
           '• Create bot user and API keys<br>' +
           '• Send welcome email with credentials<br><br>' +
           'Do you want to continue?'),
        function () {
        console.log('✅ User confirmed registration');

        // 🔴 FIX: SAVE THE DOC FIRST
        // 🔴 FIX: SAVE THE DOC FIRST (IF REQUIRED)
        const proceed = () => {
        // 🔁 Reload first to avoid timestamp conflict
        frm.reload_doc().then(() => {
            ensure_bot_ready(frm)
                .then(() => {
                    send_registration_request(frm);
                })
                .catch(() => {
                    console.error('❌ Bot setup failed, registration aborted');
                });
        });
    };

    if (frm.is_dirty()) {
        console.log('💾 Saving document before bot check...');
        frm.save()
            .then(proceed)
            .catch(() => {
                frappe.msgprint({
                    title: __('Save Failed'),
                    message: __('Please fix errors before continuing registration.'),
                    indicator: 'red'
                });
            });
    } else {
        console.log('ℹ️ Document already saved, proceeding');
        proceed();
    }



    },
        function() {
            // User cancelled
            console.log('❌ User cancelled registration');
        }
    );
}


/**
 * Validates all required fields before registration
 * 
 * Returns: { valid: boolean, message: string }
 */
function validate_registration_form(frm) {
    console.log('🔍 Validating registration form');
    
    let doc = frm.doc;
    
    // ───────────────────────────────────────────────────────────────────
    // Check required fields
    // ───────────────────────────────────────────────────────────────────
    // ✅ UPDATED: Smart company name validation
    if (frm._has_company_doctype) {
        // ERPNext: Company is mandatory
        if (!doc.company_name || doc.company_name.trim() === '') {
            return { valid: false, message: __('Company is required (ERPNext detected)') };
        }
    } else {
    // Plain Frappe: Either company or admin name required
        if ((!doc.company_name || doc.company_name.trim() === '') && 
            (!doc.admin_full_name || doc.admin_full_name.trim() === '')) {
            return { valid: false, message: __('Either Company Name or Admin Full Name is required') };
        }
    }
    
    if (!doc.admin_user_id || doc.admin_user_id.trim() === '') {
        return { valid: false, message: __('Admin User ID is required') };
    }
    
    if (!doc.admin_full_name || doc.admin_full_name.trim() === '') {
        return { valid: false, message: __('Admin Full Name is required') };
    }
    
    if (!doc.admin_email_id || doc.admin_email_id.trim() === '') {
        return { valid: false, message: __('Admin Email ID is required') };
    }
    
    if (!doc.primary_contact_number || doc.primary_contact_number.trim() === '') {
        return { valid: false, message: __('Primary Contact Number is required') };
    }
    
    if (!doc.domain_name || doc.domain_name.trim() === '') {
        return { valid: false, message: __('Domain Name is required') };
    }
    
    if (!doc.number_of_iwexclock_users || parseInt(doc.number_of_iwexclock_users) <= 0) {
        return { valid: false, message: __('Number of iWEXClock users is required') };
    }

    // ───────────────────────────────────────────────────────────────────
    // Email validation
    // ───────────────────────────────────────────────────────────────────
    let email_pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email_pattern.test(doc.admin_email_id)) {
        return { valid: false, message: __('Invalid email format') };
    }
    
    console.log('✅ Form validation passed');
    return { valid: true, message: '' };
}


/**
 * PHASE 2: Send registration request to central server
 */
function send_registration_request(frm) {
    console.log('📤 Sending registration request to central server');
    
    let doc = frm.doc;
    
    // ───────────────────────────────────────────────────────────────────
    // Call Python proxy method that will make HTTP request
    // ───────────────────────────────────────────────────────────────────
    frappe.call({
        method: 'iwexclock.iwexclock.doctype.iwexclock_settings.iwexclock_settings.register_with_iwex',
        args: {
            company_name: doc.company_name,
            admin_user_id: doc.admin_user_id,
            admin_full_name: doc.admin_full_name,
            admin_email_id: doc.admin_email_id,
            primary_contact_number: doc.primary_contact_number,
            domain_name: doc.domain_name,
            number_of_iwexclock_users: doc.number_of_iwexclock_users
        },
        freeze: true,
        freeze_message: __('Registering with iWEXClock central server...'),
        callback: function(response) {
            console.log('📥 Registration response received:', response);
            handle_registration_response(frm, response);
        },
        error: function(error) {
            console.error('🔴 Registration request failed:', error);
            frappe.msgprint({
                title: __('❌ Connection Error'),
                message: __('Failed to connect to iWEXClock central server.<br>' +
                           'Please check your internet connection and try again.'),
                indicator: 'red'
            });
        }
    });
}


/**
 * PHASE 3: Handle registration response
 */
function handle_registration_response(frm, response) {
    if (!response || !response.message) {
        console.error('❌ Invalid response format');
        frappe.msgprint({
            title: __('Error'),
            message: __('Invalid response from server'),
            indicator: 'red'
        });
        return;
    }
    
    let result = response.message;
    console.log('🔍 Processing response:', result);
    
    // ───────────────────────────────────────────────────────────────────
    // CASE 1: Registration successful
    // ───────────────────────────────────────────────────────────────────
    if (result.status === 'success') {
        console.log('✅ Registration successful');
        save_registration_data_and_create_bot(frm, result);
        return;
    }
    
    // ───────────────────────────────────────────────────────────────────
    // CASE 2: Account already exists
    // ───────────────────────────────────────────────────────────────────
    if (result.status === 'already_exists') {
        console.log('⚠️ Account already exists');
        show_account_exists_dialog(frm, result);
        return;
    }
    
    // ───────────────────────────────────────────────────────────────────
    // CASE 3: Registration failed
    // ───────────────────────────────────────────────────────────────────
    console.error('❌ Registration failed:', result.message);
    frappe.msgprint({
        title: __('❌ Registration Failed'),
        message: result.message || __('Unable to complete registration. Please try again.'),
        indicator: 'red'
    });
}


/**
 * PHASE 4: Save registration data and create bot
 * 
 * ✅ FIX APPLIED: No frontend save before backend operations
 */
function save_registration_data_and_create_bot(frm, result) {
    console.log('💾 Saving registration data');
    console.log('Data to save:', result);
    
    // ───────────────────────────────────────────────────────────────────
    // ✅ FIX: Set values but DON'T save yet
    // Backend will handle the save during bot creation
    // ───────────────────────────────────────────────────────────────────
    frm.set_value('iwexclock_id', result.register_id);
    frm.set_value('customer_id', result.customer_id);
    frm.set_value('registration_date', frappe.datetime.now_date());
    frm.set_value('registration_status', 'Registered');
    
    // ───────────────────────────────────────────────────────────────────
    // Save registration data FIRST (without bot details)
    // ───────────────────────────────────────────────────────────────────
    frm.save().then(() => {
        console.log('✅ Registration data saved');
        console.log('🤖 Starting bot & keys creation');
        
        // Now create bot user and keys (backend will save)
        create_bot_and_keys(frm);
    }).catch((error) => {
        console.error('❌ Failed to save registration data:', error);
        frappe.msgprint({
            title: __('❌ Save Error'),
            message: __('Failed to save registration data. Please try again.'),
            indicator: 'red'
        });
    });
}


/**
 * PHASE 5: Create bot user and encryption keys
 * 
 * ✅ FIX APPLIED: Backend saves, frontend only reloads
 */
function create_bot_and_keys(frm) {
    console.log('🤖 Creating bot user');
    
    // ───────────────────────────────────────────────────────────────────
    // STEP 1: Create bot user (backend saves credentials automatically)
    // ───────────────────────────────────────────────────────────────────
    frappe.call({
        method: 'iwexclock.iwexclock.doctype.iwexclock_settings.iwexclock_settings.create_bot_user',
        freeze: true,
        freeze_message: __('Creating bot user...'),
        callback: function(r) {
            console.log('📥 Bot creation response:', r);
            
            if (r.message && r.message.success) {
                console.log('✅ Bot user created');
                console.log('Bot credentials:', r.message.data);
                
                // ───────────────────────────────────────────────────────
                // STEP 2: Create encryption key
                // ───────────────────────────────────────────────────────
                frappe.call({
                    method: 'iwexclock.iwexclock.doctype.iwexclock_settings.iwexclock_settings.create_encryption_key',
                    freeze: true,
                    freeze_message: __('Creating encryption key...'),
                    callback: function(r2) {
                        console.log('📥 Encryption key response:', r2);
                        
                        if (r2.message && r2.message.success) {
                            console.log('✅ Encryption key created');
                            
                            // ───────────────────────────────────────────
                            // ✅ FIX: Only reload, don't save
                            // Backend already saved everything via sync_settings_with_api_keys()
                            // ───────────────────────────────────────────
                            // ───────────────────────────────────────────
                            // 🔐 SHOW API KEY & SECRET FIRST
                            // ───────────────────────────────────────────
                            const data = r.message.data;

                        

                            // 🔐 SHOW POPUP ONCE — LAST UI ACTION
                            setTimeout(() => {
                                frappe.msgprint({
                                    title: __('🔐 API Credentials Generated'),
                                    indicator: 'green',
                                    message: `
                                        <b>User:</b> ${data.username}<br><br>
                                        <b>API Key:</b><br>
                                        <code style="word-break:break-all">${data.api_key}</code><br><br>
                                        <b>API Secret:</b><br>
                                        <code style="word-break:break-all">${data.api_secret}</code><br><br>
                                        <small>⚠️ Copy and store these credentials securely.</small>
                                    `
                                });
                            }, 300);


                            // ───────────────────────────────────────────
                            // 📋 AUTO-COPY TO SETTINGS FIELDS
                            // ───────────────────────────────────────────
                            frm.set_value('bot_api_key', data.api_key);
                            frm.set_value('bot_api_secret', data.api_secret);

                            // ───────────────────────────────────────────
                            // 💾 SAVE SETTINGS
                            // ───────────────────────────────────────────
                            // ❌ DO NOT SAVE — backend already saved
                            frm.reload_doc().then(() => {
                                frappe.msgprint({
                                    title: __('✅ Setup Completed'),
                                    indicator: 'green',
                                    message: __('API credentials have been saved successfully.')
                                });

                                show_registration_complete_message(frm);
                            });

                        


                        } else {
                            console.error('❌ Encryption key creation failed');
                            handle_bot_or_key_failure(frm, 'encryption key');
                        }
                    },
                    error: function(error) {
                        console.error('🔴 Encryption key creation error:', error);
                        handle_bot_or_key_failure(frm, 'encryption key');
                    }
                });
            } else {
                console.error('❌ Bot user creation failed');
                handle_bot_or_key_failure(frm, 'bot user');
            }
        },
        error: function(error) {
            console.error('🔴 Bot user creation error:', error);
            handle_bot_or_key_failure(frm, 'bot user');
        }
    });
}


/**
 * Show success message after complete registration
 */
function show_registration_complete_message(frm) {
    frappe.msgprint({
        title: __('🎉 Registration Complete!'),
        message: __('<div style="padding: 15px;">' +
                   '<p><strong>Your iWEXClock account has been successfully created!</strong></p>' +
                   '<hr>' +
                   '<p><strong>✅ Account Created:</strong> iwex.in</p>' +
                   '<p><strong>✅ Bot User Created:</strong> ' + frm.doc.bot_user + '</p>' +
                   '<p><strong>✅ API Keys Generated</strong></p>' +
                   '<p><strong>✅ Encryption Key Created</strong></p>' +
                   '<hr>' +
                   '<p><strong>📧 Welcome Email:</strong> Check your inbox for credentials</p>' +
                   '<p><strong>🔗 iWEXClock ID:</strong> <code>' + frm.doc.iwexclock_id + '</code></p>' +
                   '<hr>' +
                   '<p><strong>Next Steps:</strong></p>' +
                   '<ol>' +
                   '<li>Download desktop application</li>' +
                   '<li>Install on employee computers</li>' +
                   '<li>Start tracking time and productivity</li>' +
                   '</ol>' +
                   '</div>'),
        indicator: 'green'
    });
}


/**
 * Handle bot/key creation failure
 */
function handle_bot_or_key_failure(frm, failed_item) {
    console.log('⚠️ Handling ' + failed_item + ' creation failure');
    
    // Set status to Pending Bot Creation for recovery
    frm.set_value('registration_status', 'Pending Bot Creation');
    
    frm.save().then(() => {
        frappe.msgprint({
            title: __('⚠️ Partial Success'),
            message: __('Your account was registered on iwex.in, but ' + failed_item + 
                       ' creation failed.<br><br>' +
                       'Don\'t worry! Click the <strong>"Create Bot & Keys"</strong> button to complete the setup.'),
            indicator: 'orange'
        });
        
        frm.reload_doc();
    });
}


// ═══════════════════════════════════════════════════════════════════════
//                    ACCOUNT EXISTS DIALOG (Recovery)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Show dialog when account already exists in iwex.in
 * Allows user to fetch existing registration data
 */
function show_account_exists_dialog(frm, result) {
    console.log('⚠️ Showing account exists dialog');
    console.log('Existing data:', result);
    
    let message = `
        <div style="padding: 15px;">
            <h4 style="color: #f57c00;">⚠️ Account Already Exists</h4>
            <hr>
            <p>An account with this email or domain already exists in iWEXClock:</p>
            <p><strong>iWEXClock ID:</strong> <code>${result.register_id}</code></p>
            <p><strong>Customer ID:</strong> <code>${result.customer_id}</code></p>
            <hr>
            <p>Would you like to link this existing account to your site?</p>
        </div>
    `;
    
    frappe.confirm(
        message,
        function() {
            // User wants to fetch existing data
            console.log('✅ User wants to fetch existing account');
            fetch_existing_registration(frm, result);
        },
        function() {
            // User cancelled
            console.log('❌ User cancelled');
        }
    );
}


/**
 * Fetch and save existing registration data
 */
function fetch_existing_registration(frm, result) {
    console.log('📥 Fetching existing registration data');
    
    frm.set_value('iwexclock_id', result.register_id);
    frm.set_value('customer_id', result.customer_id);
    frm.set_value('registration_date', frappe.datetime.now_date());
    frm.set_value('registration_status', 'Registered');
    
    frm.save().then(() => {
        frappe.msgprint({
            title: __('✅ Account Linked'),
            message: __('Your existing iWEXClock account has been linked to this site.<br><br>' +
                       'iWEXClock ID: <code>' + result.register_id + '</code>'),
            indicator: 'green'
        });
        
        // Reload to show updated state
        frm.reload_doc();
    });
}


// ═══════════════════════════════════════════════════════════════════════
//                    BOT & KEYS ONLY (SCENARIO 2 - Recovery)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create bot and keys only (when registration succeeded but bot failed)
 * 
 * ✅ FIX APPLIED: Same pattern as create_bot_and_keys()
 */
function create_bot_and_keys_only(frm) {
    console.log('🤖 Creating bot and keys (recovery mode)');
    
    frappe.confirm(
        __('Create Bot User & API Keys?<br><br>' +
           'Your registration is already complete.<br>' +
           'This will only create bot and keys.<br><br>' +
           'Continue?'),
        function() {
            console.log('✅ User confirmed bot creation');
            
            // Call create_bot_user (backend saves automatically)
            frappe.call({
                method: 'iwexclock.iwexclock.doctype.iwexclock_settings.iwexclock_settings.create_bot_user',
                freeze: true,
                freeze_message: __('Creating bot user...'),
                callback: function(r) {
                    if (r.message && r.message.success) {
                        // Create encryption key
                        frappe.call({
                            method: 'iwexclock.iwexclock.doctype.iwexclock_settings.iwexclock_settings.create_encryption_key',
                            freeze: true,
                            freeze_message: __('Creating encryption key...'),
                            callback: function(r2) {
                                if (r2.message && r2.message.success) {
                                    // ───────────────────────────────────────
                                    // ✅ FIX: Update status and reload
                                    // Backend already saved credentials
                                    // ───────────────────────────────────────
                                    frm.set_value('registration_status', 'Registered');
                                    
                                    frm.save().then(() => {
                                        frappe.msgprint({
                                            title: __('✅ Success'),
                                            message: __('Bot user and API keys created successfully!'),
                                            indicator: 'green'
                                        });
                                        
                                        frm.reload_doc();
                                    });
                                }
                            }
                        });
                    } else {
                        frappe.msgprint({
                            title: __('❌ Error'),
                            message: __('Failed to create bot user. Please try again.'),
                            indicator: 'red'
                        });
                    }
                }
            });
        },
        function() {
            console.log('❌ User cancelled');
        }
    );
}


// ═══════════════════════════════════════════════════════════════════════
//                    REGENERATE KEYS (SCENARIO 3)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Regenerate API keys only (for already registered accounts)
 */
function regenerate_api_keys(frm) {
    console.log('🔑 Regenerating API keys');
    
    frappe.confirm(
        __('Regenerate API Secret?<br><br>' +
           'This will:<br>' +
           '• Generate new API Secret<br>' +
           '• Old secret will stop working<br>' +
           '• API Key, Bot User, and Encryption Key will remain unchanged<br><br>' +
           'Continue?'),
        function() {
            console.log('✅ User confirmed key regeneration');
            
            // Call create_bot_user (it will detect bot exists and only regenerate keys)
            frappe.call({
                method: 'iwexclock.iwexclock.doctype.iwexclock_settings.iwexclock_settings.create_bot_user',
                freeze: true,
                freeze_message: __('Regenerating API keys...'),
                callback: function(r) {
                    console.log('📥 Regeneration response:', r);
                    
                    if (r.message && r.message.success) {
                        console.log('✅ Keys regenerated successfully');
                        
                        // ───────────────────────────────────────────────
                        // ✅ Backend already saved via sync_settings_with_api_keys()
                        // Just reload to show new values
                        // ───────────────────────────────────────────────
                        frm.reload_doc().then(() => {
                            frappe.msgprint({
                                title: __('✅ Keys Regenerated'),
                                message: __('API Secret has been regenerated successfully.<br><br>' +
                                           'New credentials have been saved.'),
                                indicator: 'green'
                            });
                        });
                    } else {
                        frappe.msgprint({
                            title: __('❌ Error'),
                            message: r.message.message || __('Failed to regenerate keys'),
                            indicator: 'red'
                        });
                    }
                },
                error: function(r) {
                    console.error('🔴 Regeneration error:', r);
                    frappe.msgprint({
                        title: __('❌ Error'),
                        message: __('Failed to regenerate keys. Please try again.'),
                        indicator: 'red'
                    });
                }
            });
        },
        function() {
            console.log('❌ User cancelled key regeneration');
        }
    );
}


// ═══════════════════════════════════════════════════════════════════════
//                    WELCOME FLOW INTEGRATION
//                    Added: December 2024
//                    Purpose: First-time setup guidance
// ═══════════════════════════════════════════════════════════════════════

/**
 * Welcome Flow Integration Module
 * 
 * This module adds first-time setup guidance without modifying
 * any existing registration logic. It hooks into form events to:
 * 
 * 1. Add Help menu integration
 * 2. Add custom action buttons
 * 3. Trigger welcome flow cleanup on registration complete
 */
frappe.provide('iwexclock_welcome_integration');

/**
 * Called on form refresh - adds UI enhancements
 */
iwexclock_welcome_integration.on_form_refresh = function(frm) {
    console.log('🎨 Welcome flow: Adding UI enhancements');
    
    // Add help menu items
   
    
    // Add custom action buttons
    iwexclock_welcome_integration.add_custom_buttons(frm);
};

/**
 * Called when registration completes - triggers cleanup
 */
iwexclock_welcome_integration.on_registration_complete = function(frm) {
    console.log('🎉 Welcome flow: Registration complete - triggering cleanup');
    
    // Clear welcome/announcement flags
    if (typeof iwexclock !== 'undefined' && 
        typeof iwexclock.welcome !== 'undefined' && 
        typeof iwexclock.welcome.clear_announcement_flag === 'function') {
        
        iwexclock.welcome.clear_announcement_flag();
        console.log('✅ Welcome flow: Announcement flags cleared');
    } else {
        console.log('⚠️ Welcome flow: iwexclock.welcome not loaded yet');
    }
    
    // Show completion message
    iwexclock_welcome_integration.show_completion_message(frm);
};

/**
 * Add iWEXClock Settings to Help menu
 */

/**
 * Add custom action buttons to form
 */
iwexclock_welcome_integration.add_custom_buttons = function(frm) {
    if (!frm.doc) return;
    
    // Only add buttons if registered
    if (frm.doc.registration_status !== 'Registered') {
        return;
    }
    
    // Add "Test Connection" button
    if (!frm.custom_buttons[__('Test Connection')]) {
        frm.add_custom_button(__('Test Connection'), function() {
            iwexclock_welcome_integration.test_connection(frm);
        }, __('Actions'));
    }
    
    // Add "Download Desktop App" button
    if (!frm.custom_buttons[__('Download Desktop App')]) {
        frm.add_custom_button(__('Download Desktop App'), function() {
            window.open('https://download.iwex.in/desktop', '_blank');
        }, __('Downloads'));
    }
    
    // Add "Documentation" button
    if (!frm.custom_buttons[__('Documentation')]) {
        frm.add_custom_button(__('Documentation'), function() {
            window.open('https://docs.iwex.in', '_blank');
        }, __('Help'));
    }
};

/**
 * Test connection to iWEXClock server
 */
iwexclock_welcome_integration.test_connection = function(frm) {
    frappe.call({
        method: 'iwexclock.iwexclock.doctype.iwexclock_settings.iwexclock_settings.test_connection',
        freeze: true,
        freeze_message: __('Testing connection...'),
        callback: function(r) {
            if (r.message && r.message.status === 'success') {
                frappe.show_alert({
                    message: __('✅ Connection successful!'),
                    indicator: 'green'
                }, 5);
            } else {
                frappe.msgprint({
                    title: __('Connection Failed'),
                    message: r.message?.message || __('Unable to connect to iWEXClock server.'),
                    indicator: 'red'
                });
            }
        }
    });
};

/**
 * Show completion message with next steps
 */
iwexclock_welcome_integration.show_completion_message = function(frm) {
    frappe.msgprint({
        title: __('🎉 Setup Complete!'),
        message: `
            <div style="padding: 15px;">
                <p><strong>Your iWEXClock installation is now ready!</strong></p>
                <br>
                <p><strong>Next Steps:</strong></p>
                <ol style="line-height: 2;">
                    <li>Download the desktop application</li>
                    <li>Install on employee computers</li>
                    <li>Configure projects and tasks in ERPNext</li>
                    <li>Start tracking time and productivity!</li>
                </ol>
                <br>
                <p style="font-size: 13px; color: #666;">
                    Need help? Visit our <a href="https://docs.iwex.in" target="_blank">documentation</a> 
                    or contact support at <a href="mailto:support@iwex.in">support@iwex.in</a>
                </p>
            </div>
        `,
        indicator: 'green',
        primary_action: {
            label: __('Download Desktop App'),
            action: function() {
                window.open('https://download.iwex.in/desktop', '_blank');
            }
        }
    });
};


// ═══════════════════════════════════════════════════════════════════════
//                    GLOBAL TOOLBAR SETUP (For All Pages)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add iWEXClock to Help menu globally (not just on Settings page)
 */