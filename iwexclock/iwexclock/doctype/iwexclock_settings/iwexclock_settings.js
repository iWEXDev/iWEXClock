// Copyright (c) 2025, iWEX Infomatics and contributors
// For license information, please see license.txt

frappe.ui.form.on('iWEXClock Settings', {
    
    refresh: function(frm) {
        // Update button label based on current state
        update_button_label(frm);
    },
    
    setup_bot_and_keys: function(frm) {
        console.log('🔵 Setup Bot & Keys button clicked');
        
        // Check if this is first time or regeneration
        let has_bot = frm.doc.bot_user ? true : false;
        let has_keys = frm.doc.bot_api_key ? true : false;
        let is_first_time = !has_bot || !has_keys;
        
        let confirm_message = is_first_time ? 
            __('Create Bot User & Generate Keys?<br><br>This will:<br>• Create role and assign permissions<br>• Create bot user<br>• Generate API Key & Secret<br>• Generate Encryption Key') :
            __('Regenerate API Keys?<br><br>This will:<br>• Regenerate API Key & Secret<br>• Keep bot user unchanged<br>• Keep encryption key unchanged');
        
        frappe.confirm(
            confirm_message,
            function() {
                console.log('✅ User confirmed');
                
                frappe.show_alert({
                    message: __('Processing...'),
                    indicator: 'blue'
                }, 3);
                
                // STEP 1: Create/Update Bot User
                frappe.call({
                    method: 'iwexclock.iwexclock.doctype.iwexclock_settings.iwexclock_settings.create_bot_user',
                    freeze: true,
                    freeze_message: __('Setting up Bot User...'),
                    callback: function(r) {
                        console.log('🟢 Bot creation response:', r);
                        
                        if (r.message && r.message.success) {
                            // Bot created successfully, now handle encryption key
                            
                            // STEP 2: Create Encryption Key (only if first time)
                            if (is_first_time) {
                                frappe.call({
                                    method: 'iwexclock.iwexclock.doctype.iwexclock_settings.iwexclock_settings.create_encryption_key',
                                    freeze: true,
                                    freeze_message: __('Creating Encryption Key...'),
                                    callback: function(r2) {
                                        console.log('🔑 Key creation response:', r2);
                                        
                                        if (r2.message && r2.message.success) {
                                            show_success_dialog(frm, r, r2, is_first_time);
                                        } else {
                                            frappe.msgprint({
                                                title: __('⚠️ Partial Success'),
                                                message: __('Bot created but encryption key failed. You can try creating the key separately.'),
                                                indicator: 'orange'
                                            });
                                        }
                                    }
                                });
                            } else {
                                // Not first time - skip encryption key, just show success
                                show_success_dialog(frm, r, null, is_first_time);
                            }
                            
                        } else {
                            frappe.msgprint({
                                title: __('❌ Error'),
                                message: r.message.message || __('Failed to setup bot user'),
                                indicator: 'red'
                            });
                        }
                    },
                    error: function(r) {
                        console.error('🔴 Server error:', r);
                        frappe.msgprint({
                            title: __('❌ Server Error'),
                            message: __('An error occurred. Check console for details.'),
                            indicator: 'red'
                        });
                    }
                });
            },
            function() {
                console.log('❌ User cancelled');
            }
        );
    }
});

function show_success_dialog(frm, bot_response, key_response, is_first_time) {
    let messages_html = '<div style="padding: 10px;">';
    
    // Bot messages
    if (bot_response.message.details) {
        bot_response.message.details.forEach(function(msg) {
            let icon = msg.type === 'success' ? '✅' : 
                      msg.type === 'info' ? 'ℹ️' : 
                      msg.type === 'warning' ? '⚠️' : '✅';
            messages_html += `<p>${icon} ${msg.message}</p>`;
        });
    }
    
    // Key messages (if first time)
    if (key_response && key_response.message.details) {
        key_response.message.details.forEach(function(msg) {
            let icon = msg.type === 'success' ? '✅' : 
                      msg.type === 'info' ? 'ℹ️' : 
                      msg.type === 'warning' ? '⚠️' : '✅';
            messages_html += `<p>${icon} ${msg.message}</p>`;
        });
    }
    
    messages_html += '<hr>';
    messages_html += '<h5>📋 Current Configuration:</h5>';
    messages_html += `<p><strong>Bot Username:</strong> <code>${bot_response.message.data.username}</code></p>`;
    messages_html += `<p><strong>API Key:</strong> <code>${bot_response.message.data.api_key}</code></p>`;
    messages_html += '<p class="text-muted">API Secret has been saved securely in Settings.</p>';
    
    if (key_response && key_response.message.data) {
        messages_html += `<p><strong>Encryption Key:</strong> <code>${key_response.message.data.masked_key}</code></p>`;
    }
    
    messages_html += '</div>';
    
    let current_frm = frm;
    
    let d = frappe.msgprint({
        title: is_first_time ? __('✅ Setup Complete') : __('✅ Keys Regenerated'),
        message: messages_html,
        indicator: 'green',
        primary_action: {
            label: __('Reload Form'),
            action: function() {
                console.log('🔄 Reload Form clicked');
                d.hide();
                current_frm.reload_doc();
            }
        }
    });
}

function update_button_label(frm) {
    if (!frm.doc) return;
    
    let has_bot = frm.doc.bot_user ? true : false;
    let has_keys = frm.doc.bot_api_key ? true : false;
    
    // If bot and keys exist, show "Regenerate Keys"
    // Otherwise show "Create Bot & Keys"
    let button_label = (has_bot && has_keys) ? 
        __('Regenerate Keys') : 
        __('Create Bot & Keys');
    
    // Update button label
    if (frm.fields_dict.setup_bot_and_keys) {
        frm.set_df_property('setup_bot_and_keys', 'label', button_label);
    }
}