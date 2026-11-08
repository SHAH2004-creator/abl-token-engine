import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime
from typing import Any, Dict, Tuple

# The signing key must come from the environment (set ORACLE_SECRET_KEY on Render / in your shell).
# If it is missing we generate a throwaway key for this process, so a public repo never contains a
# usable secret. Signatures then only stay valid until the server restarts, which is fine for demos.
ORACLE_SECRET_KEY = os.environ.get("ORACLE_SECRET_KEY") or secrets.token_hex(32)
if not os.environ.get("ORACLE_SECRET_KEY"):
    print("[oracle] ORACLE_SECRET_KEY not set: using a temporary key for this process.")

# Demo stand-in for the FBR Active Taxpayer List / ABL approved-biller registry.
APPROVED_BILLERS: Dict[str, Dict[str, Any]] = {
    "1234567-8": {"name": "Shaukat Khanum Memorial Hospital", "categories": {"MEDICAL_ALLOWANCE"}},
    "2345678-9": {"name": "Approved Private University (demo)", "categories": {"TUITION_FEE"}},
    "3456789-0": {"name": "Approved Vendor (demo)", "categories": {"VENDOR_ESCROW"}},
}


class AgenticVerificationOracle:
    """
    Autonomous AI Auditor that evaluates external proof of performance/delivery
    and emits a tamper-proof cryptographic attestation for the core ledger.
    """

    @staticmethod
    def _canonical_serialize(payload: Dict[str, Any]) -> str:
        """Serializes dictionary to canonical JSON string with pinned types."""
        normalized = {}
        for k, v in payload.items():
            if k == "approved_amount":
                normalized[k] = f"{float(v):.2f}"
            else:
                normalized[k] = str(v)
        return json.dumps(normalized, sort_keys=True, separators=(",", ":"))

    @classmethod
    def audit_invoice(cls, invoice_data: Dict[str, Any], token_data: Dict[str, Any]) -> Tuple[bool, str, Dict[str, Any]]:
        audit_log = []

        # Rule 1: Purpose Code Alignment
        token_purpose = token_data["purpose_code"]
        invoice_category = invoice_data.get("category")
        ok = token_purpose == invoice_category
        audit_log.append(f"[{'PASS' if ok else 'FAIL'}] Purpose alignment: token '{token_purpose}' vs invoice '{invoice_category}'")
        if not ok:
            return False, "FRAUD_DETECTED: Category mismatch. Token cannot be redeemed for this service.", {"logs": audit_log}

        # Rule 2: Amount Integrity Check
        invoice_amount = float(invoice_data.get("amount", 0.0))
        token_amount = float(token_data["amount"])
        ok = 0 < invoice_amount <= token_amount
        audit_log.append(f"[{'PASS' if ok else 'FAIL'}] Amount bound: invoice PKR {invoice_amount:,.2f} vs token PKR {token_amount:,.2f}")
        if not ok:
            return False, f"INSUFFICIENT_FUNDS: Invoice amount (PKR {invoice_amount:,.2f}) is outside the locked token capacity (PKR {token_amount:,.2f}).", {"logs": audit_log}

        # Rule 3: Merchant Verification against the approved-biller registry
        merchant_ntn = invoice_data.get("merchant_ntn")
        biller = APPROVED_BILLERS.get(merchant_ntn or "")
        ok = biller is not None and invoice_category in biller["categories"]
        audit_log.append(f"[{'PASS' if ok else 'FAIL'}] Registry check: NTN '{merchant_ntn}' against FBR / ABL approved-biller registry")
        if biller is None:
            return False, "INVALID_MERCHANT: Merchant NTN is unverified or unregistered.", {"logs": audit_log}
        if not ok:
            return False, "MERCHANT_NOT_AUTHORISED: Registered merchant is not approved for this purpose code.", {"logs": audit_log}

        audit_log.append("[PASS] All deterministic invariants satisfied. Attestation issued.")

        attestation_payload = {
            "token_identifier": str(token_data["token_identifier"]),
            "beneficiary_account": str(invoice_data.get("beneficiary_account_number")),
            "approved_amount": f"{invoice_amount:.2f}",
            "timestamp": datetime.utcnow().isoformat(),
            "status": "APPROVED",
        }

        serialized = cls._canonical_serialize(attestation_payload)
        signature = hmac.new(ORACLE_SECRET_KEY.encode("utf-8"), serialized.encode("utf-8"), hashlib.sha256).hexdigest()

        return True, signature, {"attestation": attestation_payload, "signature": signature, "logs": audit_log}

    @classmethod
    def verify_signature(cls, attestation_payload: Dict[str, Any], provided_signature: str) -> bool:
        """Verifies that the settlement proof was genuinely issued by this Oracle."""
        serialized = cls._canonical_serialize(attestation_payload)
        expected = hmac.new(ORACLE_SECRET_KEY.encode("utf-8"), serialized.encode("utf-8"), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, provided_signature)
