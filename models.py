import uuid
from datetime import datetime
from sqlalchemy import Column, String, Float, DateTime, Enum, ForeignKey
from database import Base
import enum

class TokenState(str, enum.Enum):
    INITIALIZED = "INITIALIZED"
    LOCKED = "LOCKED"
    ORACLE_VERIFYING = "ORACLE_VERIFYING"
    SETTLED = "SETTLED"
    REFUNDED = "REFUNDED"
    DISPUTED = "DISPUTED"

class Account(Base):
    __tablename__ = "accounts"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    account_number = Column(String, unique=True, index=True)
    title = Column(String)
    balance = Column(Float, default=0.0)
    account_type = Column(String)

class PurposeToken(Base):
    __tablename__ = "purpose_tokens"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    token_identifier = Column(String, unique=True, index=True)
    payer_id = Column(String, ForeignKey("accounts.id"))
    beneficiary_id = Column(String, ForeignKey("accounts.id"), nullable=True)
    amount = Column(Float, nullable=False)
    purpose_code = Column(String)
    state = Column(Enum(TokenState), default=TokenState.LOCKED)
    created_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=True)

class LedgerEntry(Base):
    __tablename__ = "ledger_entries"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    debit_account_id = Column(String, ForeignKey("accounts.id"))
    credit_account_id = Column(String, ForeignKey("accounts.id"))
    amount = Column(Float, nullable=False)
    reference_id = Column(String)
    description = Column(String)
    timestamp = Column(DateTime, default=datetime.utcnow)