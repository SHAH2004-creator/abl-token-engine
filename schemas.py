from datetime import datetime
from typing import Any, Dict, Optional

from pydantic import BaseModel, ConfigDict, Field


class LockTokenRequest(BaseModel):
    # extra="forbid": a misspelt or unexpected field fails loudly (422) instead of being silently ignored
    model_config = ConfigDict(extra="forbid")

    payer_account_number: str = Field(..., examples=["PKR_USER_001"])
    amount: float = Field(..., gt=0, examples=[15000.0])
    purpose_code: str = Field(..., examples=["MEDICAL_ALLOWANCE"])
    beneficiary_account_number: Optional[str] = Field(None, examples=["PKR_HOSPITAL_001"])


class OracleAuditRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token_identifier: str = Field(..., examples=["TOK-ABL-A1B2C3D4"])
    merchant_name: str = Field(..., examples=["Shaukat Khanum Memorial Hospital"])
    merchant_ntn: str = Field(..., examples=["1234567-8"])
    category: str = Field(..., examples=["MEDICAL_ALLOWANCE"])
    amount: float = Field(..., gt=0, examples=[15000.0])
    beneficiary_account_number: str = Field(..., examples=["PKR_HOSPITAL_001"])


class VerifiedSettlementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token_identifier: str
    beneficiary_account_number: str
    attestation: Dict[str, Any]
    signature: str


class TokenResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    token_identifier: str
    payer_id: str
    amount: float
    purpose_code: str
    state: str
    created_at: datetime
