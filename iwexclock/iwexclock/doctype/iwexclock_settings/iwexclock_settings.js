// Copyright (c) 2025, iWEX Infomatics and contributors
// For license information, please see license.txt

// frappe.ui.form.on("iWEXClock Settings", {
// 	refresh(frm) {

// 	},
// });
// Copyright (c) 2024, iWEX Infomatics and contributors
// For license information, please see license.txt
// iwexclock_settings.js
// Handle button field click events
// iwexclock_settings.js

frappe.ui.form.on('iWEXClock Settings', {
    
    create_bot: function(frm) {
        console.log('🟢 Create Bot button clicked');
        
        frappe.confirm(
            __('Do you want to create or update the iWEXClock Bot user?<br><br>This will:<br>• Create role and assign permissions (if needed)<br>• Create bot user (if needed)<br>• Sync API credentials to Settings'),
            function() {
                console.log('🟢 User confirmed');
                
                frappe.show_alert({
                    message: __('Processing...'),
                    indicator: 'blue'
                }, 3);
                
                frappe.call({
                    method: 'iwexclock.iwexclock.doctype.iwexclock_settings.iwexclock_settings.create_bot_user',
                    freeze: true,
                    freeze_message: __('Setting up Bot User...'),
                    callback: function(r) {
                        console.log('🟢 Server response:', r);
                        
                        if (r.message && r.message.success) {
                            frappe.show_alert({
                                message: __('Bot setup completed successfully!'),
                                indicator: 'green'
                            }, 5);
                            
                            // Build detailed message HTML
                            let messages_html = '<div style="padding: 10px;">';
                            
                            if (r.message.details) {
                                r.message.details.forEach(function(msg) {
                                    let icon = msg.type === 'success' ? '✅' : 
                                              msg.type === 'info' ? 'ℹ️' : 
                                              msg.type === 'warning' ? '⚠️' : '✅';
                                    messages_html += `<p>${icon} ${msg.message}</p>`;
                                });
                            }
                            
                            messages_html += '<hr>';
                            messages_html += `<p><strong>Bot Username:</strong> <code>${r.message.data.username}</code></p>`;
                            messages_html += `<p><strong>API Key:</strong> <code>${r.message.data.api_key}</code></p>`;
                            messages_html += '<p class="text-muted">API Secret has been saved securely in Settings.</p>';
                            messages_html += '</div>';
                            
                            // FIX 1: Store frm reference outside callback
                            let current_frm = frm;
                            
                            // Show success dialog with working Reload button
                            let d = frappe.msgprint({
                                title: __('✅ Bot User Setup Complete'),
                                message: messages_html,
                                indicator: 'green',
                                primary_action: {
                                    label: __('Reload Form'),
                                    action: function() {
                                        console.log('🟢 Reload Form clicked');
                                        
                                        // Close the dialog first
                                        d.hide();
                                        
                                        // Then reload the form
                                        current_frm.reload_doc();
                                        
                                        console.log('🟢 Form reloaded');
                                    }
                                }
                            });
                            
                        } else {
                            frappe.msgprint({
                                title: __('❌ Error'),
                                message: r.message.message || __('Failed to create bot user'),
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
                console.log('🔴 User cancelled');
            }
        );
    },
    create_key: function(frm) {
        console.log('🔑 Create Encryption Key button clicked');
        
        frappe.confirm(
            __('Do you want to generate an encryption key?<br><br>This will:<br>• Generate a Fernet encryption key<br>• Save to site_config.json (if not exists)<br>• Save to doctype field<br><br><b>Note:</b> Existing keys will not be overwritten.'),
            function() {
                console.log('🔑 User confirmed');
                
                frappe.show_alert({
                    message: __('Generating encryption key...'),
                    indicator: 'blue'
                }, 3);
                
                frappe.call({
                    method: 'iwexclock.iwexclock.doctype.iwexclock_settings.iwexclock_settings.create_encryption_key',
                    freeze: true,
                    freeze_message: __('Creating Encryption Key...'),
                    callback: function(r) {
                        console.log('🔑 Server response:', r);
                        
                        if (r.message && r.message.success) {
                            frappe.show_alert({
                                message: __('Encryption key setup completed!'),
                                indicator: 'green'
                            }, 5);
                            
                            // Build detailed message HTML
                            let messages_html = '<div style="padding: 10px;">';
                            
                            if (r.message.details) {
                                r.message.details.forEach(function(msg) {
                                    let icon = msg.type === 'success' ? '✅' : 
                                              msg.type === 'info' ? 'ℹ️' : 
                                              msg.type === 'warning' ? '⚠️' : '✅';
                                    messages_html += `<p>${icon} ${msg.message}</p>`;
                                });
                            }
                            
                            messages_html += '<hr>';
                            messages_html += '<h5>Encryption Key Details:</h5>';
                            messages_html += `<p><strong>Masked Key:</strong> <code>${r.message.data.masked_key}</code></p>`;
                            messages_html += `<p><strong>Key Length:</strong> ${r.message.data.key_length} characters</p>`;
                            
                            if (r.message.data.key_generated) {
                                messages_html += '<p class="text-success"><b>✅ New key generated</b></p>';
                            } else {
                                messages_html += '<p class="text-info"><b>ℹ️ Using existing key</b></p>';
                            }
                            
                            messages_html += '<hr>';
                            messages_html += '<p class="text-muted"><small>The full key is securely stored in:<br>';
                            messages_html += '• site_config.json<br>';
                            messages_html += '• iWEXClock Settings doctype </small></p>';
                            messages_html += '</div>';
                            
                            // Store frm reference
                            let current_frm = frm;
                            
                            // Show success dialog
                            let d = frappe.msgprint({
                                title: __('🔑 Encryption Key Setup Complete'),
                                message: messages_html,
                                indicator: 'green',
                                primary_action: {
                                    label: __('Reload Form'),
                                    action: function() {
                                        console.log('🔑 Reload Form clicked');
                                        d.hide();
                                        current_frm.reload_doc();
                                        
                                        frappe.show_alert({
                                            message: __('Form reloaded'),
                                            indicator: 'green'
                                        }, 2);
                                    }
                                }
                            });
                            
                        } else {
                            frappe.msgprint({
                                title: __('❌ Error'),
                                message: r.message.message || __('Failed to create encryption key'),
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
                console.log('🔴 User cancelled');
            }
        );
    }
});