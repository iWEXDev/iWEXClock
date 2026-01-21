# -*- coding: utf-8 -*-
from __future__ import unicode_literals
import frappe
from cryptography.fernet import Fernet, InvalidToken
import base64
import json
import requests


def decrypt_iwexclock_fields(doc, method=None):
    

    fields_to_decrypt = [
        'urlfile_name',
        'keyboard_hits',
        'mouse_hits',
        'app_name',
        'language'
    ]

    frappe.logger().info(f"=== DECRYPT HOOK CALLED === Method: {method}, Doc: {doc.name}")

    # Get encryption key from site_config.json
    encryption_key = frappe.conf.get('encryption_key')

    if not encryption_key:
        frappe.log_error("Encryption key missing in site_config.json", "IWEXClock Decryption Error")
        frappe.logger().error("encryption_key not found in site_config.json")
        return

    frappe.logger().info(f"encryption_key loaded: {encryption_key[:15]}...")

    # Prepare Fernet cipher
    if isinstance(encryption_key, str):
        encryption_key = encryption_key.encode('utf-8')

    try:
        cipher = Fernet(encryption_key)
    except Exception as e:
        frappe.log_error(f"Invalid encryption key: {str(e)}", "IWEXClock Decryption Error")
        frappe.logger().error(f"Invalid encryption key: {e}")
        return

    # Loop through each field and attempt decryption
    for field in fields_to_decrypt:
        try:
            value = doc.get(field)

            frappe.logger().info(f"Processing field '{field}', value: {str(value)[:60]}")

            if not value:
                continue

            # Only decrypt fernet encrypted values
            if isinstance(value, str) and value.startswith("gAAAA"):
                try:
                    decrypted = cipher.decrypt(value.encode('utf-8')).decode('utf-8')
                    doc.set(field, decrypted)

                    frappe.logger().info(f"✓ Decrypted '{field}' → {decrypted[:60]}")

                except InvalidToken:
                    frappe.logger().warning(f"InvalidToken: '{field}' is not valid Fernet data.")
                    continue

                except Exception as e:
                    frappe.logger().error(f"Error decrypting '{field}': {e}")
                    frappe.log_error(
                        f"Failed to decrypt field '{field}'\nValue: {value}\nError: {str(e)}",
                        "IWEXClock Decryption Error"
                    )
            else:
                frappe.logger().info(f"Skipping '{field}', does not look encrypted.")
                
        except Exception as field_error:
            frappe.logger().error(f"Unexpected error in field '{field}': {field_error}")
            frappe.log_error(
                f"Unexpected decryption error on field '{field}': {field_error}",
                "IWEXClock Decryption Error"
            )
            continue
